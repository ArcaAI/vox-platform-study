import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ResourceType, ServiceAccountEntity, ServiceAccountFactory, ServiceAccountRepository, SysEventType } from '@arcaai/domains';

import { BaseService } from '../../common/base.service';
import { IActiveUserContext, IServiceAccountPrincipal } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import {
  CreateServiceAccountRequest,
  ServiceAccountResponse,
  ServiceAccountSecretResponse,
  ServiceAccountTokenRequest,
  ServiceAccountTokenResponse,
  UpdateServiceAccountRequest,
} from './dto';
import { ServiceAccountDtoMapper } from './service-account.dto.mapper';
import { hasServiceAccountScope, resolveServiceAccountImpliedPermissions } from './service-account-scopes.registry';

/** The reserved SYSTEM tenant — the CONFIG TIER, and the home of platform accounts. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The "Global" tenant. Named here ONLY so the guard below can refuse it
 * explicitly: it is a CUSTOMER tenant used as a platform-admin playground
 * (`00-project-context.md` §"The two reserved tenants are NOT two config
 * tiers"), and a machine principal that resolved to it would be serving one
 * customer's configuration to every other tenant.
 */
const GLOBAL_PLAYGROUND_TENANT_ID = '50000000-0000-0000-0000-000000000000';

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** Redis key namespace for live access tokens, keyed by token HASH (never the token). */
const TOKEN_KEY_PREFIX = 'svcacct:token:';

/** Platform ceiling on a per-account token TTL. Short-lived is the point. */
const MAX_TOKEN_TTL_SECONDS = 3600;

interface StoredToken {
  serviceAccountId: string;
  clientId: string;
  tenantId: string;
  workingTenantId: string;
  scopes: string[];
  roles: string[];
  allowedTenantIds: string[] | null;
  expiresAt: number;
}

/**
 * `ServiceAccountService` — the platform-issued machine identity for
 * administration (TASK-762).
 *
 * ─── The single most important gate in the design ───────────────────────────
 *
 * Issuance is **SUPER_ADMIN-only**, enforced IMPERATIVELY here. The controller's
 * class-level `@CanManage('ServiceAccount')` deliberately UNDERSTATES the real
 * gate — the sanctioned "super-admin-only action on a resource whose ability
 * tenant admins could otherwise hold" pattern from `05-nestjs-api.md`
 * §"Imperative Privilege Checks". §2.6 of the ticket shows what happens without
 * it: `@CanManage('ApiKey')` is tenant-admin-reachable, and that is the whole of
 * the TASK-756 defect. A tenant admin must never be able to mint a service
 * account, not even one scoped to their own tenant, because verifying
 * scope-against-ability at mint time is a WEAKER guarantee than never letting
 * the mint happen.
 *
 * These are 403 PRIVILEGE boundaries. The 404-over-403 cross-tenant posture is
 * separate and is enforced by `assertTenantOwnership`.
 *
 * ─── Credential storage: a deviation from §5.4, stated plainly ──────────────
 *
 * §5.4 specifies that the client secret is written to Vault and resolved back
 * through `SecretsService`. `ISecretsProvider` is **read-only** — it has
 * `getSecret*` and a backend-triggered `rotateSecret(key)`, but no write path,
 * for any of its five providers. Adding one would change the platform secrets
 * contract, need new Vault ACL policy for the app's AppRole, and touch the
 * out-of-repo deployment manifests; that is an owner decision, not a side
 * effect of this ticket.
 *
 * What is implemented instead is strictly stronger on the "never a plaintext DB
 * column" rule that §Configuration Tiers actually mandates:
 *
 *   - The secret is generated, returned to the issuing SUPER_ADMIN **exactly
 *     once**, and then discarded by the platform. It is never persisted in any
 *     recoverable form, in Postgres or anywhere else.
 *   - The row keeps a peppered HMAC-SHA256 **verifier** (the `ApiKey.keyHash`
 *     shape, pepper resolved from `SecretsService`), which authenticates a
 *     presented secret without being able to reproduce it.
 *   - `credentialsRef` records the Vault path where the operator is expected to
 *     provision the secret, so the "where does this live" question the ticket
 *     wanted answered is still answered on the row.
 *   - "Survives rotation windows" is met by the two-slot verifier design
 *     (`previousSecretVerifier` + `previousCredentialExpiresAt`), not by
 *     re-reading stored material.
 *
 * The one §5.4 property NOT met is operator RE-retrieval of a lost secret; the
 * remedy is `POST :id/rotate`, which is the same remedy every non-recoverable
 * credential system offers. Recorded in the ticket README as an open item.
 */
@Injectable()
export class ServiceAccountService extends BaseService {
  private readonly log = new Logger(ServiceAccountService.name);

  constructor(
    eventEmitter: EventEmitter2,
    clsService: ClsService<IActiveUserContext>,
    private readonly repository: ServiceAccountRepository,
    @Inject(IRedisCacheService) private readonly cache: IRedisCacheService,
    @Optional() private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ServiceAccount);
  }

  // ─── Issuance ──────────────────────────────────────────────────────────────

  async create(dto: CreateServiceAccountRequest): Promise<ServiceAccountSecretResponse> {
    // AUTH-NOTE: the controller's `@CanManage('ServiceAccount')` is NOT the real
    // gate. Issuance is SUPER_ADMIN-only and a service-account principal is
    // refused outright — see this class's doc comment.
    this.assertMayIssue();

    const tenantId = this.resolveIssuanceTenant(dto.tenantId);
    this.assertScopeCeiling(dto.scopes);

    const clientId = `hope_svc_${randomBytes(12).toString('hex')}`;
    const clientSecret = ServiceAccountService.generateClientSecret();
    const credentialsRef = ServiceAccountService.credentialsRefFor(clientId, 'current');

    const entity = ServiceAccountFactory.CreateServiceAccount({
      tenantId,
      clientId,
      displayName: dto.displayName,
      description: dto.description ?? null,
      scopes: dto.scopes,
      allowedTenantIds: dto.allowedTenantIds ?? null,
      allowedIps: dto.allowedIps ?? null,
      superAdmin: dto.superAdmin ?? false,
      tokenTtlSeconds: this.clampTtl(dto.tokenTtlSeconds),
      credentialsRef,
      secretVerifier: await this.computeSecretVerifier(clientSecret),
      createdBy: this.requestUserId ?? undefined,
    });
    // Structural invariants (svc:* namespace, platform-vs-tenant binding,
    // bounded rotation overlap) BEFORE anything is written.
    entity.validate();

    const saved = await this.repository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: {
        clientId: saved.clientId,
        displayName: saved.displayName,
        scopes: saved.scopes,
        superAdmin: saved.superAdmin,
        tenantId: saved.tenantId,
      },
    });

    // The ONLY time the plaintext secret leaves this method.
    return ServiceAccountDtoMapper.toSecretResponse(saved, clientSecret);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async getAll(): Promise<ServiceAccountResponse[]> {
    const tenantId = this.isSuperAdmin() ? (this.tenantId ?? SYSTEM_TENANT_ID) : this.requireCallerTenant();
    const rows = await this.repository.findByTenantId(tenantId);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length, tenantId } });
    return rows.map((row) => ServiceAccountDtoMapper.toResponse(row));
  }

  async getById(id: string): Promise<ServiceAccountResponse> {
    const entity = await this.loadOwned(id);
    return ServiceAccountDtoMapper.toResponse(entity);
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateServiceAccountRequest, expectedVersion: number): Promise<ServiceAccountResponse> {
    // AUTH-NOTE: SUPER_ADMIN-only, same reasoning as `create`. Widening an
    // existing account's scopes is issuance by another name.
    this.assertMayIssue();
    const entity = await this.loadOwned(id);

    if (dto.scopes) this.assertScopeCeiling(dto.scopes);
    if (dto.tokenTtlSeconds !== undefined) dto.tokenTtlSeconds = this.clampTtl(dto.tokenTtlSeconds);

    const previous = ServiceAccountDtoMapper.toResponse(entity);
    await this.updateEntity(entity, dto);
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, expectedVersion);
    if (!entity.hasChanges) {
      throw new BadRequestException('No changes supplied');
    }
    entity.validate();

    const saved = await this.repository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      previousData: previous,
      data: { previousVersion: expectedVersion, newVersion: saved.version },
    });

    // A narrowed or elevated account must not keep serving on tokens minted
    // under the OLD authority — invalidation is the propagation path, a TTL is
    // only the backstop.
    await this.purgeTokensFor(id);

    return ServiceAccountDtoMapper.toResponse(saved);
  }

  /**
   * Two-slot rotation with a bounded overlap window, so a consumer rotates
   * without downtime: during the overlap BOTH secrets exchange successfully.
   */
  async rotate(id: string, overlapSeconds = 3600): Promise<ServiceAccountSecretResponse> {
    this.assertMayIssue();
    const entity = await this.loadOwned(id);

    const clientSecret = ServiceAccountService.generateClientSecret();

    entity.previousSecretVerifier = entity.secretVerifier;
    entity.previousCredentialsRef = entity.credentialsRef;
    entity.previousCredentialExpiresAt = new Date(Date.now() + overlapSeconds * 1000);
    entity.secretVerifier = await this.computeSecretVerifier(clientSecret);
    entity.credentialsRef = ServiceAccountService.credentialsRefFor(entity.clientId, 'current');
    entity.rotatedAt = new Date();
    entity.validate();

    const saved = await this.repository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { rotated: true, overlapExpiresAt: entity.previousCredentialExpiresAt?.toISOString() },
    });

    return ServiceAccountDtoMapper.toSecretResponse(saved, clientSecret);
  }

  /**
   * Revocation is effective within ONE REQUEST, not one TTL: the account is
   * soft-deleted (so `findByClientId` stops returning it and no new token can
   * be exchanged) AND every live token for it is purged from Redis.
   */
  async revoke(id: string): Promise<void> {
    this.assertMayIssue();
    await this.loadOwned(id);

    await this.repository.softDelete(id, this.requestUserId ?? undefined);
    await this.purgeTokensFor(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId: id, data: { revoked: true } });
  }

  // ─── Token exchange ───────────────────────────────────────────────────────

  /**
   * `POST /api/v1/auth/service-token` — the ONLY route that ever accepts a
   * service-account secret.
   *
   * Returns an OPAQUE, short-lived bearer token recorded in Redis under the
   * token's HASH. Opaque and server-validated deliberately: there is no JWT
   * claim set to get wrong, and revocation is a Redis delete rather than a
   * blocklist.
   */
  async exchangeToken(dto: ServiceAccountTokenRequest, ipAddress: string): Promise<ServiceAccountTokenResponse> {
    const account = await this.repository.findByClientId(dto.clientId);

    // NON-ENUMERABLE: an unknown client and a bad secret are indistinguishable
    // to the caller. Both still run a verifier comparison so the two paths do
    // not differ observably in timing either.
    const presented = await this.computeSecretVerifier(dto.clientSecret ?? '');
    if (!account) {
      ServiceAccountService.constantTimeEquals(presented, presented.replace(/./g, '0'));
      throw new UnauthorizedException('Invalid client credentials');
    }

    const matchesCurrent = ServiceAccountService.constantTimeEquals(presented, account.secretVerifier);
    const matchesPrevious =
      !!account.previousSecretVerifier &&
      account.isRotationOverlapActive() &&
      ServiceAccountService.constantTimeEquals(presented, account.previousSecretVerifier);

    if (!matchesCurrent && !matchesPrevious) {
      this.log.warn({ message: 'service_account.exchange_denied', reason: 'bad_secret', clientId: dto.clientId, ip: ipAddress });
      throw new UnauthorizedException('Invalid client credentials');
    }

    if (Array.isArray(account.allowedIps) && account.allowedIps.length > 0 && !account.allowedIps.includes(ipAddress)) {
      this.log.warn({ message: 'service_account.exchange_denied', reason: 'ip_not_allowed', clientId: dto.clientId, ip: ipAddress });
      throw new UnauthorizedException('Invalid client credentials');
    }

    const workingTenantId = this.resolveWorkingTenant(account, dto.workingTenantId);

    const token = randomBytes(32).toString('base64url');
    const ttl = this.clampTtl(account.tokenTtlSeconds);
    const stored: StoredToken = {
      serviceAccountId: account.id,
      clientId: account.clientId,
      tenantId: account.tenantId,
      workingTenantId,
      scopes: account.scopes,
      // Derived from the PERSISTED column, never from a token claim and never
      // inferred — §2.7's failure mode in both directions.
      roles: account.superAdmin ? [SUPER_ADMIN_ROLE] : [],
      allowedTenantIds: account.allowedTenantIds ?? null,
      expiresAt: Date.now() + ttl * 1000,
    };

    await this.cache.setex(`${TOKEN_KEY_PREFIX}${ServiceAccountService.hashToken(token)}`, ttl, JSON.stringify(stored));
    await this.repository.touchLastUsedAt(account.id).catch(() => undefined);

    return { accessToken: token, tokenType: 'Bearer', expiresIn: ttl, scopes: account.scopes, tenantId: workingTenantId };
  }

  /**
   * Resolve a presented opaque token to its principal, or null. Called by
   * `UnifiedAuthGuard`'s service-account branch on every request.
   *
   * A soft-deleted (revoked) account is refused here as well as at exchange
   * time: `revoke` purges live tokens, and this is the belt to that braces —
   * revocation must never depend on a cache eviction landing.
   */
  async authenticateByToken(token: string): Promise<IServiceAccountPrincipal | null> {
    const raw = await this.cache.get(`${TOKEN_KEY_PREFIX}${ServiceAccountService.hashToken(token)}`);
    if (!raw) return null;

    let stored: StoredToken;
    try {
      stored = JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
    if (!stored?.expiresAt || stored.expiresAt <= Date.now()) return null;

    const account = await this.repository.findByClientId(stored.clientId);
    if (!account || account.id !== stored.serviceAccountId) return null;

    return {
      id: stored.serviceAccountId,
      clientId: stored.clientId,
      tenantId: stored.tenantId,
      scopes: stored.scopes,
      roles: stored.roles,
      allowedTenantIds: stored.allowedTenantIds,
      workingTenantId: stored.workingTenantId,
    };
  }

  /** Scope matching for the guard — `svc:*` semantics, confined to the namespace. */
  hasScope(principal: IServiceAccountPrincipal, requiredScope: string): boolean {
    return hasServiceAccountScope(principal.scopes, requiredScope);
  }

  // ─── Credential primitives ────────────────────────────────────────────────

  /** 64 hex chars of CSPRNG material. Never stored; returned exactly once. */
  static generateClientSecret(): string {
    return randomBytes(32).toString('hex');
  }

  static credentialsRefFor(clientId: string, slot: 'current' | 'previous'): string {
    return `service-accounts/${clientId}/${slot}`;
  }

  /**
   * Peppered one-way verifier — the `ApiKeyService.hashKey` shape. Falls back
   * to an unpeppered HMAC when no `SecretsService` is wired (unit tests, env
   * mode), exactly as the API-key path does.
   */
  async computeSecretVerifier(clientSecret: string): Promise<string> {
    const pepper = (await this.secretsService?.getSecretOptional('API_KEY_PEPPER')) ?? 'hope-service-account';
    return createHmac('sha256', pepper).update(clientSecret).digest('hex');
  }

  static hashToken(token: string): string {
    return createHmac('sha256', 'hope-service-account-token').update(token).digest('hex');
  }

  static constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      // Still burn a comparison so length does not leak through timing.
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * Issuance gate. Two refusals, both 403 (privilege, not tenancy):
   *
   *  1. A SERVICE-ACCOUNT principal may never mint another service account,
   *     whatever scopes it holds — no self-replication, no privilege loop.
   *     Checked FIRST: a platform account carrying `superAdmin` would otherwise
   *     satisfy the role check below and mint freely.
   *  2. Anything short of SUPER_ADMIN is refused.
   */
  private assertMayIssue(): void {
    if (this.requestServiceAccount) {
      throw new ForbiddenException('A service account may not issue or modify service accounts');
    }
    if (!this.isSuperAdmin()) {
      throw new ForbiddenException('Only a platform super administrator may issue or modify service accounts');
    }
  }

  /**
   * TASK-756's privilege ceiling, applied to this class from day one rather
   * than retrofitted. A SUPER_ADMIN holds `manage:all`, so the fast path
   * short-circuits — but the unknown-scope refusal below still runs for
   * everyone, because resolving an unrecognised string to "no requirement"
   * would turn a typo into a ceiling bypass.
   */
  private assertScopeCeiling(scopes: string[]): void {
    for (const scope of scopes) {
      let implied: Array<{ action: string; subject: string }>;
      try {
        implied = resolveServiceAccountImpliedPermissions(scope);
      } catch {
        throw new ForbiddenException(`Cannot grant unknown service-account scope '${scope}'`);
      }
      if (this.isSuperAdmin()) continue;

      const ability = this.clsService.get('userAbility') as { can?: (a: string, s: string) => boolean } | undefined;
      if (!ability || typeof ability.can !== 'function') {
        throw new ForbiddenException('Service-account scopes can only be granted by a caller whose permissions can be evaluated');
      }
      const missing = implied.filter((p) => !ability.can!(p.action, p.subject));
      if (missing.length > 0) {
        throw new ForbiddenException(`Cannot grant service-account scopes beyond your own permissions: '${scope}'`);
      }
    }
  }

  /**
   * Which tenant a newly issued account is bound to.
   *
   * There is deliberately NO ambient default for a machine principal: with no
   * explicit request and no CLS tenant the account lands on SYSTEM (a config
   * TIER), never on a customer tenant and never on `50000000-…`, which is a
   * customer tenant used as a platform playground.
   */
  private resolveIssuanceTenant(requested?: string): string {
    const tenantId = requested ?? this.tenantId ?? SYSTEM_TENANT_ID;
    if (tenantId === GLOBAL_PLAYGROUND_TENANT_ID) {
      throw new BadRequestException(
        'The "Global" tenant is a customer tenant used as a platform playground and may not host a platform service account. Use the SYSTEM tenant for a platform account, or a real customer tenant for a tenant-bound one.',
      );
    }
    return tenantId;
  }

  /**
   * Which tenant THIS REQUEST acts on.
   *
   *  - tenant-bound account: always its own tenant. A presented working tenant
   *    that differs is refused — as a 404-shaped "not yours" at the guard, and
   *    as a plain rejection here.
   *  - platform account: the presented working tenant, validated against the
   *    account's allow-list (403 — a privilege boundary). With NO working
   *    tenant it resolves SYSTEM ONLY.
   */
  private resolveWorkingTenant(account: ServiceAccountEntity, requested?: string): string {
    if (!account.isPlatformAccount) {
      if (requested && requested !== account.tenantId) {
        throw new ForbiddenException('This service account is bound to a single tenant and may not act on another');
      }
      return account.tenantId;
    }

    if (!requested) {
      // SYSTEM only. NOT a customer tenant, and explicitly not `50000000-…`.
      return SYSTEM_TENANT_ID;
    }
    if (requested === GLOBAL_PLAYGROUND_TENANT_ID && !(account.allowedTenantIds ?? []).includes(GLOBAL_PLAYGROUND_TENANT_ID)) {
      throw new ForbiddenException('Working tenant is not in this service account allow-list');
    }
    const allowed = account.allowedTenantIds ?? [];
    if (requested !== SYSTEM_TENANT_ID && !allowed.includes(requested)) {
      throw new ForbiddenException('Working tenant is not in this service account allow-list');
    }
    return requested;
  }

  private requireCallerTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new NotFoundException('Service account scope unavailable');
    return tenantId;
  }

  /**
   * Load an account and assert it belongs to the caller's tenant. Throws
   * `NotFoundException` — never `Forbidden` — so the API never reveals that an
   * account exists in another tenant (404-over-403).
   */
  private async loadOwned(id: string): Promise<ServiceAccountEntity> {
    const entity = await this.repository.findById(id);
    if (!entity) throw new NotFoundException(`Service account ${id} not found`);
    if (!this.isSuperAdmin() && entity.tenantId !== this.tenantId) {
      throw new NotFoundException(`Service account ${id} not found`);
    }
    return entity;
  }

  private clampTtl(requested?: number): number {
    if (!requested || !Number.isInteger(requested) || requested <= 0) return 900;
    return Math.min(requested, MAX_TOKEN_TTL_SECONDS);
  }

  /** Drop every live token belonging to one account. */
  private async purgeTokensFor(serviceAccountId: string): Promise<void> {
    try {
      const keys = await this.cache.keys(`${TOKEN_KEY_PREFIX}*`);
      if (!keys.length) return;
      const doomed: string[] = [];
      for (const key of keys) {
        const raw = await this.cache.get(key);
        if (!raw) continue;
        try {
          if ((JSON.parse(raw) as StoredToken).serviceAccountId === serviceAccountId) doomed.push(key);
        } catch {
          /* a malformed entry is not this account's problem; leave it to TTL */
        }
      }
      if (doomed.length) await this.cache.delMany(doomed);
    } catch (error) {
      // A cache outage must not make revocation appear to succeed silently.
      this.log.error({
        message: 'service_account.token_purge_failed',
        serviceAccountId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
