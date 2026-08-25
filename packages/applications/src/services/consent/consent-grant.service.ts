import { Inject, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConsentGrantEntity,
  ConsentGrantFactory,
  ConsentGrantMethod,
  ConsentGrantRepository,
  ConsentPurpose,
  HarnessAuditAction,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  type ConsentGrant,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IConsentGrantService } from './IConsentGrantService';
import {
  ConsentGrantResponse,
  ConsentGrantState,
  CreateConsentGrantRequest,
  ListConsentGrantsQuery,
  PaginatedConsentGrantResponse,
  RevokeConsentGrantRequest,
} from './dto';
import { ConsentGrantDtoMapper } from './consent-grant.dto.mapper';
import {
  assertEqualTenants,
  BaseService,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  FetchResponse,
  withFormattedCountProps,
  withFormattedPaginatedProps,
} from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { CONSENT_INVALIDATE_EVENT, normalizeExternalPatientId } from './consent.constants';
import { HarnessAuditService } from '../harness-audit/harness-audit.service';

/**
 * Admin CRUD for `ConsentGrant` (TASK-712, consent-abac).
 *
 * This service does NOT evaluate consent for a caller — that is
 * `ConsultationConsentService.assertConsent`/`checkConsent`, the ABAC choke
 * point. This service only creates and revokes grant rows.
 *
 * WORM ledger (Phase 4 follow-up): create/revoke broadcast the standard
 * `AuditLog` sys-event (`ResourceCreated`/`ResourceUpdated`) like every other
 * application service, AND append a `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` row
 * to the hash-chained `HarnessAuditEvent` ledger — giving those two
 * previously-dead enum members real writers (README acceptance criterion).
 * `consultationId` is `null` on these rows: a grant/revoke is keyed on
 * `(tenantId, externalPatientId, purpose)`, not a consultation — see
 * `harness.prisma`'s field comment and `consent-design.md` §6 for the
 * hash-compatibility reasoning that makes the column nullable in the first
 * place. `modelName`/`modelVersion`/`sensorScores`/`citations` carry the same
 * sentinel shape `SummaryService.approveSummary` already uses for the
 * clinician-attestation `ATTEST` event (a human action, not a model run).
 */
@Injectable()
export class ConsentGrantService extends BaseService implements IConsentGrantService {
  private readonly logger = new Logger(ConsentGrantService.name);

  constructor(
    private readonly consentGrantRepository: ConsentGrantRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional + trailing (mirrors SummaryService's ATTEST wiring): existing
    // positional test fixtures keep compiling; production DI
    // (ConsentGrantServiceModule) always supplies it, which is what makes the
    // WORM append fail-closed in production (see create()/revoke() below).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsentGrant);
  }

  /**
   * One row per (tenant, externalPatientId, purpose) among ACTIVE
   * (non-revoked) grants — enforced by the partial unique index
   * `ConsentGrant_tenant_patient_purpose_active_key` (WHERE "revokedAt" IS
   * NULL). A second `create` for the same triple fails at the database ONLY
   * while an active grant already exists; `revoke` then `create` again (or
   * widening — consent-design.md §3) both work, because the revoked row no
   * longer occupies the active slot.
   */
  async create(request: CreateConsentGrantRequest): Promise<ConsentGrantResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    const externalPatientId = normalizeExternalPatientId(request.externalPatientId);

    const entity = ConsentGrantFactory.CreateConsentGrant({
      tenantId,
      externalPatientId,
      purpose: request.purpose,
      scope: request.scope ?? null,
      grantedAt: request.grantedAt ? new Date(request.grantedAt) : undefined,
      grantedBy: this.requestUser?.id ?? 'system',
      grantMethod: request.grantMethod,
      evidenceRef: request.evidenceRef ?? null,
      expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
      createdBy: this.requestUser?.id,
    });

    const saved = await this.consentGrantRepository.create(entity);

    // WORM ledger write — fail-closed, same posture as `SummaryService`'s
    // ATTEST append: an audit-append failure propagates and the caller sees
    // create() reject (never a success-shaped response for an ungranted
    // audit trail). See the class docblock for why consultationId is null.
    await this.appendWormEvent(HarnessAuditAction.CONSENT_GIVEN, saved, tenantId);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { externalPatientId: saved.externalPatientId, purpose: saved.purpose, grantMethod: saved.grantMethod },
    });

    this.eventEmitter.emit(CONSENT_INVALIDATE_EVENT, { tenantId, externalPatientId, purpose: saved.purpose });

    return ConsentGrantDtoMapper.toResponse(saved);
  }

  /**
   * OCC-versioned revoke. Load-then-assert defense-in-depth: a cross-tenant
   * id 404s BEFORE the CAS write fires (never mutated), same posture as
   * `WebhookService.update`.
   */
  async revoke(id: string, request: RevokeConsentGrantRequest): Promise<ConsentGrantResponse> {
    const entity: ConsentGrantEntity = await this.consentGrantRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    entity.revoke(this.requestUser?.id ?? 'system', request.reason ?? null);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, request.expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('Grant is already revoked.');
    }

    const previousVersion = entity.version;
    const updated = await this.consentGrantRepository.updateWithVersion(id, entity, request.expectedVersion);

    // WORM ledger write — see create()'s comment for the fail-closed posture
    // and the null-consultationId reasoning.
    await this.appendWormEvent(HarnessAuditAction.CONSENT_WITHDRAWN, updated, updated.tenantId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    this.eventEmitter.emit(CONSENT_INVALIDATE_EVENT, {
      tenantId: updated.tenantId,
      externalPatientId: updated.externalPatientId,
      purpose: updated.purpose,
    });

    return ConsentGrantDtoMapper.toResponse(updated);
  }

  /**
   * Every purpose a consultation implies (TASK-805 owner directive,
   * 2026-08-25). Enumerated from the enum rather than hand-listed so a new
   * `ConsentPurpose` is covered the day it is added — a purpose that exists
   * but is silently never granted would reintroduce exactly the dead-end this
   * directive removes.
   */
  private static readonly CONSULTATION_PURPOSES: readonly ConsentPurpose[] = Object.values(ConsentPurpose);

  /**
   * Record the consent a doctor gives by ACT OF OPENING A CONSULTATION
   * (owner directive, 2026-08-25): starting a consultation for a patient IS
   * the attestation that the patient consented, so every purpose is granted
   * at that moment.
   *
   * This does NOT contradict owner decision D-3 (`@ForbidServiceAccount` on
   * this controller — "consent is an act of a PERSON"). The caller here is a
   * clinician's own request context: `create()` stamps `grantedBy` with the
   * CLS request user, so every row is attributable to the human who opened the
   * consultation, and each one still appends `CONSENT_GIVEN` to the WORM
   * ledger. What D-3 forbids is a MACHINE identity with nobody behind it; this
   * is the opposite.
   *
   * IDEMPOTENT, and deliberately not a revoke-override: a purpose that already
   * has an ACTIVE grant is skipped (the DB's partial unique index would reject
   * a second one anyway). A purpose whose previous grant was REVOKED is
   * granted afresh — which is correct rather than a loophole, because a new
   * consultation is a new consent event, and a patient who withdrew consent
   * last month may consent again today. The consequence to know: a revocation
   * blocks gated calls for the CURRENT consultation, but does not outlive the
   * opening of the next one.
   */
  async ensureConsultationConsent(externalPatientId: string): Promise<ConsentGrantResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    const normalized = normalizeExternalPatientId(externalPatientId);
    const now = new Date();
    const granted: ConsentGrantResponse[] = [];

    for (const purpose of ConsentGrantService.CONSULTATION_PURPOSES) {
      const existing = await this.consentGrantRepository.findByTenantPatientPurpose(tenantId, normalized, purpose);
      if (existing?.isActive(now)) {
        continue;
      }
      granted.push(
        await this.create({
          externalPatientId: normalized,
          purpose,
          // The clinician is attesting in person; there is no signed artifact
          // and no portal interaction to point at.
          grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
        }),
      );
    }

    if (granted.length > 0) {
      this.logger.log({
        message: 'Consultation open recorded consent for the patient',
        tenantId,
        externalPatientId: normalized,
        grantedBy: this.requestUser?.id,
        purposes: granted.map((g) => g.purpose),
      });
    }

    return granted;
  }

  /**
   * The consent register (TASK-805). Tenant-scoped, paginated, with optional
   * patient / purpose / lifecycle filters.
   *
   * Replaces the original `getByPatient(externalPatientId)`, which REQUIRED a
   * patient id and returned a bare array — usable as a per-patient lookup but
   * not as a governance surface, because a tenant admin auditing consent has
   * no way to enumerate the patients in the first place (HOPE stores no
   * `Patient` model; `externalPatientId` is an opaque caller-supplied string).
   *
   * `state: ACTIVE` is evaluated with the SAME predicate the ABAC choke point
   * uses (`ConsentGrantEntity.isActive` — not revoked as of now, not expired
   * as of now), so a row this register calls Active is exactly a row
   * `assertConsent` would allow at that instant. Expressed here as a Prisma
   * predicate rather than a post-filter so `count` stays consistent with
   * `data` across pages.
   */
  async list(query: ListConsentGrantsQuery): Promise<PaginatedConsentGrantResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    const { page, limit } = query;
    const where = this.buildListWhere(tenantId, query);

    const paginatedProps = withFormattedPaginatedProps<ConsentGrant>(query);
    const countProps = withFormattedCountProps(query);

    const grants = await this.consentGrantRepository.findAll({
      ...paginatedProps,
      sort: this.stableSort(paginatedProps.sort),
      where: { ...paginatedProps.where, ...where },
    });
    const count = await this.consentGrantRepository.count({
      ...countProps,
      where: { ...countProps.where, ...where },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { items: grants.map((grant) => grant.id), count },
    });

    return ConsentGrantDtoMapper.ToPaginatedResponse(
      new FetchResponse<ConsentGrantEntity>({ data: grants, count, limit: limit ?? DEFAULT_PAGE_SIZE, page: page ?? DEFAULT_PAGE }),
    );
  }

  /**
   * A TOTAL order, always — the requested sort (or `grantedAt` desc) with `id`
   * appended as the tiebreaker.
   *
   * Without it offset pagination is unsound on this table: `grantedAt` is not
   * unique (the seed stamps every demo grant with the same instant, and a bulk
   * import does the same), and Postgres gives no ordering guarantee between
   * rows that tie on every ORDER BY key. Page 2 is then free to repeat rows
   * from page 1 and silently omit others — caught by the register's own
   * pagination e2e. `id` is a UUIDv7, so appending it is both unique and
   * monotonic in creation time, which keeps the tiebreak stable rather than
   * merely deterministic.
   */
  private stableSort(requested: Array<Record<string, 'asc' | 'desc'>> | undefined): Array<Record<string, 'asc' | 'desc'>> {
    const base = requested?.length ? requested : [{ grantedAt: 'desc' as const }];
    return base.some((rule) => 'id' in rule) ? base : [...base, { id: 'desc' as const }];
  }

  /**
   * Prisma predicate for the register's filters. `now` is captured ONCE and
   * reused by both the `findAll` and the `count` call so a page boundary
   * cannot straddle an expiry instant and report a count the rows disagree
   * with.
   */
  private buildListWhere(tenantId: string, query: ListConsentGrantsQuery): Record<string, unknown> {
    const now = new Date();
    const where: Record<string, unknown> = { tenantId, resourceStatus: ResourceStatusType.ENABLED };

    if (query.externalPatientId) {
      where.externalPatientId = normalizeExternalPatientId(query.externalPatientId);
    }
    if (query.purpose) {
      where.purpose = query.purpose;
    }

    switch (query.state ?? ConsentGrantState.ALL) {
      case ConsentGrantState.ACTIVE:
        // Mirrors ConsentGrantEntity.isActive(now): never revoked (or revoked
        // in the future), and either no expiry or an expiry still ahead.
        where.AND = [{ OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
        break;
      case ConsentGrantState.REVOKED:
        where.revokedAt = { not: null, lte: now };
        break;
      case ConsentGrantState.ALL:
      default:
        break;
    }

    return where;
  }

  /**
   * Append one CONSENT_GIVEN/CONSENT_WITHDRAWN row to the WORM ledger.
   * `consultationId: null` — a grant/revoke has no consultation (see class
   * docblock). `modelName`/`modelVersion`/`sensorScores`/`citations` are the
   * same sentinel shape `SummaryService.approveSummary` uses for ATTEST (a
   * human action, not a model run) — this is the established precedent for a
   * clinical WORM row with no model/generation to describe, not a new
   * convention invented here.
   *
   * `@Optional()` in the constructor means this is a genuine no-op (not a
   * throw) when `harnessAuditService` is unset — production DI
   * (`ConsentServiceModule`) always supplies it, so the no-op path is
   * exercised only by unit fixtures that construct this service directly.
   */
  private async appendWormEvent(action: HarnessAuditAction, grant: ConsentGrantEntity, tenantId: string): Promise<void> {
    if (!this.harnessAuditService) {
      return;
    }
    try {
      await this.harnessAuditService.append({
        tenantId,
        consultationId: null,
        action,
        modelName: 'consent-administration',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: action === HarnessAuditAction.CONSENT_GIVEN ? grant.grantedBy : (grant.revokedBy ?? grant.grantedBy),
        createdBy: action === HarnessAuditAction.CONSENT_GIVEN ? grant.grantedBy : (grant.revokedBy ?? grant.grantedBy),
      });
    } catch (error) {
      this.logger.error({
        message: 'ConsentGrantService: WORM audit append failed — the mutation already committed but is NOT reflected on the ledger',
        action,
        grantId: grant.id,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new InternalServerErrorException('Failed to append ConsentGrant WORM audit event');
    }
  }
}
