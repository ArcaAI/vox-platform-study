import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import {
  CoreDatabaseService,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  UserDepartmentFactory,
  UserDepartmentRepository,
  UserFactory,
  UserProfileFactory,
  UserProfileRepository,
  UserRepository,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import {
  IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY,
  IDENTITY_AUTO_PROVISION_ENABLED_KEY,
  IDENTITY_AUTO_PROVISION_ROLE_ID_KEY,
} from '../../settings-registry/descriptors/user-identity.descriptors';
import {
  IContextUserIdentityService,
  ResolveUserIdentityInput,
  ResolveUserIdentityResult,
  UserIdentityProvenance,
} from './IContextUserIdentityService';

/** Mirrors the identity-provider JIT guard: never assignable by a machine request. */
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * Upper bound on a staff identifier.
 *
 * 128 is not a storage limit (the column is TEXT) — it is an INPUT bound on a value that reaches
 * a `hashtext()` advisory lock and an indexed equality predicate. Every real staff identifier
 * (an employee number, an NPI, a hospital login) is an order of magnitude shorter; anything
 * beyond this is a payload defect or an attempt to use the column as a scratchpad.
 */
const MAX_STAFF_ID_LENGTH = 128;

/**
 * ASCII control characters, DEL included.
 *
 * A staff id round-trips through logs, an advisory-lock hash and an admin console. A newline or
 * a NUL in it is never legitimate and is exactly the shape of a log-injection or display-spoof
 * payload, so it is refused at the edge rather than escaped at every consumer.
 */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** `auto_` + 16 hex characters (8 random bytes). Pinned by the tests and by plan OD-7. */
const PROVISIONED_USERNAME_PREFIX = 'auto_';

/**
 * How many times the provisioning transaction is retried on a username collision.
 *
 * The retry wraps the WHOLE transaction, not just the INSERT, because a failed statement aborts
 * a Postgres transaction — every subsequent query in it would fail with "current transaction is
 * aborted", so retrying in place is not an option. Re-running is safe and self-correcting: the
 * advisory lock is released at rollback, and the fresh attempt re-runs the find, so a request
 * that lost a race provisions nothing and returns the winner's user.
 *
 * With 64 bits of randomness a genuine collision is not a thing that happens. The loop exists
 * because `User.username` is a PLATFORM-GLOBAL unique column and the alternative failure mode
 * is a 500 on a clinical request.
 */
const MAX_USERNAME_ATTEMPTS = 3;

/** Prisma's unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Find-or-provision a tenant user from a context-schema staff identifier (TASK-950, D-8/D-9/D-10).
 *
 * ## The one-sentence contract
 *
 * Given a tenant and a staff identifier, return the HOPE `User` that identifier names — creating
 * it, with the same four rows the identity-provider JIT path writes, when policy allows and none
 * exists.
 *
 * ## Why this is a service and not four lines in each plane
 *
 * Three planes need it (consultation open, agent invocation, workflow run) and each reaches its
 * payload through a different validator. Three copies would be three chances to skip the
 * advisory lock, the seat quota or the SUPER_ADMIN guard — and each of those omissions fails
 * SILENTLY: a duplicate user, an unbilled seat, a machine-minted platform administrator.
 *
 * ## Why the four rows, and why one transaction
 *
 * `assertUserBelongsToTenant` requires BOTH an ENABLED `UserRoleAssignment` and an ENABLED
 * `UserDepartment` in the tenant. A `User` written without them is an account that cannot log
 * in and that 404s the moment it is named as a clinician — so a partial write is worse than no
 * write, and the four rows go in one transaction or not at all. This is the same shape and the
 * same `password: ''` "no local credential" sentinel as `FederatedAuthService.provisionUser`,
 * deliberately: "how a HOPE user gets created" keeps one answer.
 *
 * ## Why the advisory lock
 *
 * Two simultaneous first requests for the same staff id both miss the find and both provision —
 * two users, one identifier, and the NEXT request gets 409 `USER_IDENTITY_AMBIGUOUS` forever.
 * `UserProfile` carries no tenant column, so a database unique on `(tenantId, staffId)` is not
 * available (plan D-4 / OD-2). `pg_advisory_xact_lock(hashtext(tenantId || ':' || staffId))`
 * serialises the two, and the re-check INSIDE the lock is what makes the loser reuse rather
 * than duplicate. A hash collision between two different staff ids costs one serialised request,
 * never a wrong answer — the lock guards the section, it does not decide the outcome.
 *
 * ## Attribution (plan D-11)
 *
 * The service account stays the ACTOR: `broadcastSysEvent` stamps `responsibleServiceAccountId`
 * from CLS, and this service never touches that. The resolved user is BUSINESS DATA — it lands
 * on `Consultation.doctorId` / `subject.userId` and in `_metadata.provisioning` on the new row.
 * Stamping the clinician as the writer would attribute a machine action to a person.
 */
@Injectable()
export class ContextUserIdentityService extends BaseService implements IContextUserIdentityService {
  private readonly logger = new Logger(ContextUserIdentityService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `baseClient.$transaction(callback)` is the canonical Prisma-7 atomic idiom here, and the
    // base client is also the only way to reach `$executeRaw` for the advisory lock.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // The tenant → SYSTEM cascade for the three `identity.autoProvision.*` keys.
    private readonly effectiveSettings: EffectiveSettingsService,
    // Optional (append-only DI), mirroring `UserService`: enforces the plan `maxUsers` SEAT
    // quota, kill-switch-gated. An unwired graph does not silently grant unlimited seats — it
    // is a composition that has no entitlements service at all (unit tests, offline tooling).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  async resolveOrProvision(input: ResolveUserIdentityInput): Promise<ResolveUserIdentityResult> {
    const staffId = this.normaliseStaffId(input.staffId);
    const { tenantId } = input;

    const existing = await this.findUserIdByStaffId(tenantId, staffId);
    if (existing) return { userId: existing, provisioned: false };

    // Only NOW is the gate consulted, so switching auto-provisioning off never affects a staff
    // id that already resolves — it only stops NEW ones being minted.
    if (!(await this.autoProvisionEnabled(tenantId))) {
      throw new NotFoundException({
        message: `No user in this tenant carries the supplied staff identifier, and automatic provisioning is disabled for this tenant. Onboard the clinician first, or enable '${IDENTITY_AUTO_PROVISION_ENABLED_KEY}'.`,
        code: 'USER_IDENTITY_UNKNOWN',
      });
    }

    return this.provision(tenantId, staffId, input.departmentId ?? null, input.provenance);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Normalisation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Trim, then refuse anything that is not a usable identifier (plan D-10).
   *
   * Trimming is not cosmetic: `'DR-1'` and `'DR-1 '` would otherwise be two DIFFERENT staff ids,
   * hash to two different advisory locks, and provision two users for one clinician. The
   * whitespace is invisible in every log and console that would later be used to diagnose it.
   */
  private normaliseStaffId(raw: string): string {
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (value.length === 0) {
      throw new BadRequestException({
        message: 'The user-identity field is present but empty. A staff identifier must be a non-blank string.',
        code: 'USER_IDENTITY_INVALID',
      });
    }
    if (value.length > MAX_STAFF_ID_LENGTH) {
      throw new BadRequestException({
        message: `The user-identity value is ${value.length} characters; the maximum is ${MAX_STAFF_ID_LENGTH}.`,
        code: 'USER_IDENTITY_INVALID',
      });
    }
    if (CONTROL_CHARACTERS.test(value)) {
      throw new BadRequestException({
        message: 'The user-identity value contains control characters, which a staff identifier never legitimately does.',
        code: 'USER_IDENTITY_INVALID',
      });
    }

    return value;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Find
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The ONE predicate that decides which profiles a staff id names in a tenant.
   *
   * Built here and used by BOTH lookups — the pre-transaction one through the repository and the
   * in-transaction re-check through the raw `tx` delegate — because those two run against
   * DIFFERENT clients. The repository's client carries the soft-delete extension; a `tx` handed
   * out by `baseClient.$transaction` carries NO extensions at all. Two hand-written predicates
   * would therefore be two different queries wearing one name, and the divergence would show up
   * only as an occasional duplicate user.
   *
   * Every clause earns its place:
   *  · `staffId`                              — the identifier itself.
   *  · profile `resourceStatus not DELETED`   — stated explicitly, because the `tx` path has no
   *                                             extension to add it.
   *  · `User.resourceStatus not DELETED`      — a deleted user is not a match.
   *  · `UserRoleAssignments.some({ tenantId, ENABLED })` — THE tenant boundary. `UserProfile`
   *    has no tenant column; a user's tenant IS its role assignment, so this clause is the only
   *    thing that stops one tenant's staff id resolving to another tenant's user.
   */
  private staffIdWhere(tenantId: string, staffId: string): Record<string, unknown> {
    return {
      staffId,
      resourceStatus: { not: ResourceStatusType.DELETED },
      User: {
        resourceStatus: { not: ResourceStatusType.DELETED },
        UserRoleAssignments: { some: { tenantId, resourceStatus: ResourceStatusType.ENABLED } },
      },
    };
  }

  /**
   * The user this staff id names in this tenant, or null when it names none.
   *
   * Goes through the domain repository (services never touch `databaseService.client`). The
   * relational `some` filter is passed as a raw predicate — `DbFilters` cannot model it — which
   * is the same escape the existing tenant-scoped listings use (`UserService.fetchAllByTenantId`,
   * `DepartmentService`).
   */
  private async findUserIdByStaffId(tenantId: string, staffId: string): Promise<string | null> {
    const profiles = await this.userProfileRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma relational filter (`some`); `DbFilters` models scalar comparisons only. Same escape as UserService.fetchAllByTenantId.
      where: this.staffIdWhere(tenantId, staffId) as any,
      page: 1,
      // 2, not 1: a second row is the DIFFERENCE between "reuse this user" and 409
      // `USER_IDENTITY_AMBIGUOUS`. Fetching one would silently pick a winner and hide the
      // defect — and which user a consultation is attributed to is not a coin toss.
      limit: 2,
    });

    return this.decideMatch(
      profiles.map((profile) => profile.userId),
      // The repository's extended client has already excluded DELETED users, but NOT disabled,
      // suspended or archived ones — the status the caller must not silently reuse.
      async (userId) => (await this.userRepository.findById(userId)).resourceStatus,
    );
  }

  /**
   * The same lookup, re-run INSIDE the provisioning transaction and under the advisory lock.
   *
   * Goes through the `tx` delegate directly and not through the repository, because
   * `Repository.findAll` reads its CACHED client and takes no `tx` — a repository read here
   * would run on a different connection, outside the lock, and see a stale snapshot. That is
   * precisely the race this re-check exists to close.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an un-extended `$transaction` client, reached by delegate name; Prisma's own tx type is not exported in a form this helper can name.
  private async findUserIdByStaffIdInTx(tx: Record<string, any>, tenantId: string, staffId: string): Promise<string | null> {
    const profiles: Array<{ userId: string; User: { resourceStatus: ResourceStatusType } | null }> = await tx.userProfile.findMany({
      where: this.staffIdWhere(tenantId, staffId),
      select: { userId: true, User: { select: { resourceStatus: true } } },
      take: 2,
    });

    return this.decideMatch(
      profiles.map((profile) => profile.userId),
      async (userId) => profiles.find((profile) => profile.userId === userId)?.User?.resourceStatus ?? null,
    );
  }

  /**
   * Turn a match set into an outcome (plan D-10). Shared by both lookups so the two can never
   * disagree about what "ambiguous" or "not usable" means.
   *
   * `null` = provision. Anything else is either a reusable user id or a refusal.
   */
  private async decideMatch(userIds: string[], statusOf: (userId: string) => Promise<ResourceStatusType | null>): Promise<string | null> {
    if (userIds.length === 0) return null;

    if (userIds.length > 1) {
      // Surfaced, never repaired. Two users sharing one staff id is a DATA defect (a
      // pre-advisory-lock race, or a hand-edited profile), and silently choosing one would
      // attribute consultations to whichever row happened to sort first — different on different
      // days. An operator must merge them.
      throw new ConflictException({
        message: 'More than one user in this tenant carries the supplied staff identifier. Staff identifiers must be unique per tenant; resolve the duplicate before retrying.',
        code: 'USER_IDENTITY_AMBIGUOUS',
      });
    }

    const userId = userIds[0]!;
    const status = await statusOf(userId);
    if (status !== ResourceStatusType.ENABLED) {
      // NOT re-provisioned. The identifier is CLAIMED; minting a second user for it would
      // manufacture exactly the ambiguity above and would also route a clinical request to a
      // brand-new account while an administrator believes that clinician is deactivated.
      throw new NotFoundException({
        message: 'A user in this tenant carries the supplied staff identifier but is not active. Re-enable that user rather than provisioning a second one.',
        code: 'USER_IDENTITY_NOT_USABLE',
      });
    }

    return userId;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Policy
  // ───────────────────────────────────────────────────────────────────────────

  /** `identity.autoProvision.enabled` — tenant → SYSTEM → `true` (open-to-default, plan OD-3). */
  private async autoProvisionEnabled(tenantId: string): Promise<boolean> {
    const resolved = await this.effectiveSettings.resolveEffective(IDENTITY_AUTO_PROVISION_ENABLED_KEY, { tenantId });
    return resolved.value !== false;
  }

  /**
   * `identity.autoProvision.roleId` — fail-CLOSED, so an unresolved value PROPAGATES.
   *
   * Deliberately not caught: substituting a role would grant a provisioned clinician a set of
   * abilities nobody chose, which is the failure `failMode: 'closed'` exists to prevent.
   */
  private async resolveRoleId(tenantId: string): Promise<string> {
    const resolved = await this.effectiveSettings.resolveEffective(IDENTITY_AUTO_PROVISION_ROLE_ID_KEY, { tenantId });
    return String(resolved.value);
  }

  /**
   * The department for a provisioned user: request → tenant setting → refuse (plan D-9 / OD-8).
   *
   * The setting is fail-closed, and here that raise means "the tenant has no opinion", not "the
   * request fails" — so it is caught and converted into the plane-specific 400 below, which
   * names the actual remedy. Only `ArgumentInvalidException` (the declared fail-closed raise) is
   * swallowed; a backend error still propagates, so an unreachable control plane can never be
   * reported to an integrator as "you forgot to configure a department".
   */
  private async resolveDepartmentId(tenantId: string, requested: string | null): Promise<string> {
    if (requested) return requested;

    let configured: unknown;
    try {
      configured = (await this.effectiveSettings.resolveEffective(IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY, { tenantId })).value;
    } catch (error) {
      if (!(error instanceof ArgumentInvalidException)) throw error;
      configured = undefined;
    }

    if (typeof configured === 'string' && configured.length > 0) return configured;

    // Raised BEFORE anything is written. A user created without a department cannot satisfy
    // `assertUserBelongsToTenant`, so it could never log in and would 404 the first time it was
    // named as a clinician — a defect discovered weeks later, by a clinician.
    throw new BadRequestException({
      message: `No department could be resolved for the user to be provisioned. Send a department with the request, or set '${IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY}' for this tenant.`,
      code: 'USER_IDENTITY_DEPARTMENT_UNRESOLVED',
    });
  }

  /**
   * SUPER_ADMIN is never assignable here — the identity-provider JIT guard, mirrored.
   *
   * Read through the base client (like that precedent) rather than a repository: `Role` is a
   * SYSTEM shared-read model and this check must see the row regardless of the caller's tenant
   * scope. It is a NAME check, not an id check, so pointing the setting at a tenant-cloned role
   * that happens to be called `SUPER_ADMIN` does not slip past it.
   */
  private async assertRoleAssignable(roleId: string): Promise<void> {
    const role = await this.databaseService.baseClient.role.findUnique({ where: { id: roleId }, select: { name: true } });
    if (role?.name === SUPER_ADMIN_ROLE) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned to an auto-provisioned user.');
    }
  }

  /**
   * The plan `maxUsers` SEAT quota, enforced BEFORE the write (plan OD-9).
   *
   * Seat counting mirrors `UserService.countTenantSeats` exactly — distinct users with at least
   * one ENABLED role assignment — so an auto-provisioned clinician consumes a seat on the same
   * terms as an admin-created one. A machine plane that could mint unbilled users would be a
   * hole in the entitlement, not a convenience. `QuotaExceededException` (409) propagates to
   * the integrator unchanged: a refused seat is actionable, a silently-skipped quota is not.
   */
  private async assertSeatAvailable(tenantId: string): Promise<void> {
    if (!this.entitlements?.isEnforcementEnabled()) return;

    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      select: { userId: true },
      distinct: ['userId'],
    });
    await this.entitlements.assertQuantityQuota(tenantId, 'maxUsers', rows.length);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Provision
  // ───────────────────────────────────────────────────────────────────────────

  private async provision(
    tenantId: string,
    staffId: string,
    requestedDepartmentId: string | null,
    provenance: UserIdentityProvenance,
  ): Promise<ResolveUserIdentityResult> {
    // Resolved ONCE, outside the retry loop: these are reads, they cannot change between
    // attempts, and holding an advisory lock across a settings resolve would widen the
    // serialised section for no reason.
    const roleId = await this.resolveRoleId(tenantId);
    await this.assertRoleAssignable(roleId);
    const departmentId = await this.resolveDepartmentId(tenantId, requestedDepartmentId);
    await this.assertSeatAvailable(tenantId);

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.runProvisioningTransaction(tenantId, staffId, roleId, departmentId, provenance);
      } catch (error) {
        if (!this.isUsernameCollision(error) || attempt >= MAX_USERNAME_ATTEMPTS) throw error;
        // WARN, not debug: 64 bits of randomness means this should never fire. If it does
        // repeatedly, the generator is broken, and that is worth waking someone for.
        this.logger.warn(`Auto-provisioned username collided on attempt ${attempt}; regenerating. tenantId=${tenantId}`);
      }
    }
  }

  /**
   * One attempt: lock, re-check, write four rows, broadcast.
   *
   * Returns `provisioned: false` when the re-check found a user — that is the LOSER of a race
   * taking the winner's row, which is the entire point of the lock.
   */
  private async runProvisioningTransaction(
    tenantId: string,
    staffId: string,
    roleId: string,
    departmentId: string,
    provenance: UserIdentityProvenance,
  ): Promise<ResolveUserIdentityResult> {
    const username = this.generateUsername();

    const outcome = await this.databaseService.baseClient.$transaction(async (txClient) => {
      // Widened to an index type so the two raw statements below and the delegate lookups in
      // `findUserIdByStaffIdInTx` read uniformly. Note what this client is NOT: a `tx` handed
      // out by `baseClient.$transaction` carries NO client extensions, so neither the
      // soft-delete filter nor tenant-scope injection applies to anything issued through it —
      // which is exactly why `staffIdWhere` states its non-DELETED clauses explicitly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const tx = txClient as unknown as Record<string, any>;

      // FIRST statement in the transaction, before any read. `pg_advisory_xact_lock` is held
      // until commit or rollback and needs no explicit release, so there is no path — exception
      // included — on which this leaks a lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${staffId}`}))`;

      // The re-check that makes the lock worth taking. Without it the lock would only serialise
      // two duplicate inserts rather than prevent the second.
      const raced = await this.findUserIdByStaffIdInTx(tx, tenantId, staffId);
      if (raced) return { userId: raced, provisioned: false as const };

      const newUser = UserFactory.CreateUser({
        username,
        // The house "no local credential" sentinel (`UserService.create`): neither validated nor
        // hashed, and the account stays non-loginable until a password-module write. A machine
        // must never be able to mint an account with a password it knows.
        password: '',
        isServiceAccount: false,
        // Makes an auto-provisioned account findable and filterable in the admin console without
        // parsing the username.
        tags: ['auto-provisioned'],
      });
      const createdUser = await this.userRepository.create(newUser, tx);

      // `_metadata` is a real `User` column but the domain entity does not surface it (no
      // getter, not in `CreateUserProps`), so the factory + mapper cannot carry it. Written
      // directly through `tx` — inside the same transaction, so it commits or rolls back with
      // the four rows. Surfacing `metaData` on `UserEntity` is a domain change and belongs with
      // the `staffId` trio, not here.
      await tx.user.update({
        where: { id: createdUser.id },
        data: {
          metaData: {
            provisioning: {
              source: 'context-schema',
              plane: provenance.plane,
              kindKey: provenance.kindKey,
              field: provenance.field,
              // The ACTOR. Recorded on the row because an audit log rolls over and this
              // question ("who minted this account?") is asked long afterwards.
              serviceAccountId: provenance.serviceAccountId,
              ...(provenance.schemaId ? { schemaId: provenance.schemaId } : {}),
              ...(provenance.versionNumber === undefined ? {} : { versionNumber: provenance.versionNumber }),
              at: new Date().toISOString(),
            },
          },
        },
      });

      const createdProfile = await this.userProfileRepository.create(UserProfileFactory.CreateUserProfile({ userId: createdUser.id, staffId }), tx);

      const createdRoleAssignment = await this.userRoleAssignmentRepository.create(
        UserRoleAssignmentFactory.CreateUserRoleAssignment({ userId: createdUser.id, roleId, tenantId }),
        tx,
      );

      const createdDepartment = await this.userDepartmentRepository.create(
        // `isPrimary: true` — it is the user's only department, so anything else would leave a
        // clinician with no primary. Mirrors the JIT path.
        UserDepartmentFactory.CreateUserDepartment({ tenantId, userId: createdUser.id, departmentId, isPrimary: true }),
        tx,
      );

      return { userId: createdUser.id, provisioned: true as const, createdUser, createdProfile, createdRoleAssignment, createdDepartment };
    });

    if (!outcome.provisioned) return { userId: outcome.userId, provisioned: false };

    // Broadcast AFTER commit, so a rolled-back attempt emits no audit noise. `broadcastSysEvent`
    // (not the pre-session `emitSysEvent` the JIT path uses) because this runs IN-session: CLS
    // holds the request's tenant and the service-account principal, and those are the correct,
    // non-spoofable attribution.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.User,
      resourceId: outcome.createdUser.id,
      createdAt: outcome.createdUser.createdAt,
      data: { tenantId, userId: outcome.createdUser.id, username, provisioning: provenance },
    });
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.UserProfile,
      resourceId: outcome.createdProfile.id,
      createdAt: outcome.createdProfile.createdAt,
      data: { tenantId, userId: outcome.createdUser.id },
    });
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.UserRoleAssignment,
      resourceId: outcome.createdRoleAssignment.id,
      createdAt: outcome.createdRoleAssignment.createdAt,
      data: { tenantId, userId: outcome.createdUser.id, roleId },
    });
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.UserDepartment,
      resourceId: outcome.createdDepartment.id,
      createdAt: outcome.createdDepartment.createdAt,
      data: { tenantId, userId: outcome.createdUser.id, departmentId },
    });

    // One structured line per provision. Deliberately carries tenantId + userId and NOT the
    // staff identifier: it is the tenant's own employee identifier, it may be PII, and it is
    // never needed to diagnose this event — the userId leads to the profile that holds it,
    // behind the tenancy checks that guard every other read of it.
    this.logger.log(
      `Auto-provisioned a user from a context-schema identity field. tenantId=${tenantId} userId=${outcome.createdUser.id} ` +
        `plane=${provenance.plane} roleId=${roleId} departmentId=${departmentId} serviceAccountId=${provenance.serviceAccountId}`,
    );

    return { userId: outcome.userId, provisioned: true };
  }

  /** `auto_<16 hex>` (plan OD-7). The staff id NEVER appears in it — it may be PII. */
  private generateUsername(): string {
    return `${PROVISIONED_USERNAME_PREFIX}${randomBytes(8).toString('hex')}`;
  }

  /**
   * A Prisma unique violation on `User.username`, and nothing else.
   *
   * Narrow on purpose: retrying a DIFFERENT unique violation would re-run the transaction three
   * times and then surface the same error, having hidden the real cause behind two pointless
   * round trips.
   */
  private isUsernameCollision(error: unknown): boolean {
    const candidate = error as { code?: unknown; meta?: { target?: unknown } } | null;
    if (!candidate || candidate.code !== PRISMA_UNIQUE_VIOLATION) return false;

    const target = candidate.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
    return fields.some((field) => field.toLowerCase().includes('username'));
  }
}
