import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiProviderConnectionEntity,
  AiProviderConnectionFactory,
  AiProviderConnectionRepository,
  CoreDatabaseService,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import { decryptSecretField, encryptSecretField } from '../baseServices/_meta/secrets/secret-field.util';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import {
  IProviderConnectionService,
  PlatformDefaultOutcome,
  ProviderFunding,
  ProviderOverrideEntry,
  ProviderOverrides,
  ResolvedProviderConnection,
  ResolvedProviderOverrides,
} from './IProviderConnectionService';
import { AiProviderConnectionDtoMapper } from './ai-provider-connection.dto.mapper';
import { ProviderService, isCloudByoProvider } from './constants';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

/**
 * Unified provider-connection service.
 *
 * Owns WHERE a serving provider lives and HOW to authenticate to it — as the DB
 * control plane for ALL THREE AI capabilities (llm | stt | tts), keyed by
 * (tenant, SERVICE, provider). Replaces per-service env configuration AND the
 * former per-capability credential tables.
 *
 * TWO privilege boundaries, both 403 (NOT the 404-over-403 cross-tenant
 * posture — these are rules about the caller's OWN tenant, not existence
 * probes on someone else's):
 *   - a TENANT row is permitted only for a cloud BYO provider LISTED UNDER ITS
 *     SERVICE (C5); a self-host engine endpoint is platform infrastructure;
 *   - a SYSTEM row may be written only by a super admin.
 *
 * Secrets travel through `encryptSecretField` exclusively; there is no
 * plaintext-at-rest fallback (a key write is REJECTED when Vault is absent), and
 * no read path — and no route at all — ever returns the ciphertext.
 */
@Injectable()
export class AiProviderConnectionService extends BaseService implements IProviderConnectionService {
  private readonly logger = new Logger(AiProviderConnectionService.name);

  constructor(
    private readonly connectionRepository: AiProviderConnectionRepository,
    // The UNSCOPED base client backing the cross-tenant lane (mirrors
    // `AiTaskDefaultService`) — a super admin acting under working tenant W
    // must be able to read/write SYSTEM and foreign-tenant rows.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so non-Vault deploys still run; key writes then reject.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // The platform-default entitlement gate. Optional so this
    // service still constructs in unit tests and in any composition that does
    // not import the entitlements module — but an ABSENT gate DENIES the SYSTEM
    // tier rather than granting it. Failing open here would spend the
    // platform's money on a wiring mistake; failing closed reproduces exactly
    // the pre-cascade behaviour (tenant tier only), which is a safe default.
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.AiProviderConnection);
  }

  async list(service: ProviderService, tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const rows = await this.connectionRepository.findByTenantIdAndService(service, scopedTenantId, tx);
    return rows.map((r) => AiProviderConnectionDtoMapper.toResponse(r));
  }

  async getRow(service: ProviderService, provider: string, tenantId?: string): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const row = await this.connectionRepository.findByTenantServiceProvider(service, provider, scopedTenantId, tx);
    return row ? AiProviderConnectionDtoMapper.toResponse(row) : AiProviderConnectionDtoMapper.placeholder(service, scopedTenantId, provider);
  }

  async upsertRow(
    service: ProviderService,
    provider: string,
    dto: UpsertAiProviderConnectionRequest,
    tenantId?: string,
    expectedVersion?: number,
  ): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    this.assertWriteAllowed(service, provider, scopedTenantId);

    // C2 supplies `expectedVersion` as an explicit param; the pre-unification
    // convention carried it inside the DTO. Prefer the explicit param, fall back
    // to the DTO — so the gateway may pass it either way during the transition.
    const ev = expectedVersion ?? dto.expectedVersion;

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantServiceProvider(service, provider, scopedTenantId, tx);

    if (!existing) {
      if (ev !== undefined && ev !== 0) {
        throw new OptimisticConcurrencyException('AiProviderConnection', `${scopedTenantId}:${service}:${provider}`, {
          expectedVersion: ev,
          currentVersion: 0,
        });
      }

      // F-028 — restore-with-overwrite. The unique (tenantId, service, provider)
      // index counts soft-DELETED rows, so a plain INSERT after a delete
      // collides with the tombstone (409 unique-constraint) with no HTTP
      // recovery path. A create-intent (`If-Match: "0"`) over a DELETED row
      // instead REVIVES it — restore + apply every field as a fresh write.
      const deleted = await this.connectionRepository.findDeletedByTenantServiceProvider(service, provider, scopedTenantId, tx);
      if (deleted) {
        return this.restoreAndOverwrite(deleted, dto, service, provider, scopedTenantId, tx);
      }

      // Encrypt only when the caller actually supplied a key — and only AFTER
      // the precondition verdict above (encrypting first would turn a
      // stale-If-Match 412 into a 500 whenever Transit was down).
      const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;
      const entity = AiProviderConnectionFactory.CreateAiProviderConnection({
        tenantId: scopedTenantId,
        service,
        provider,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        apiVersion: dto.apiVersion ?? null,
        deploymentName: dto.deploymentName ?? null,
        encryptedApiKey: secret?.ciphertext ?? null,
        keyVersion: secret?.keyVersion ?? null,
        enabled: dto.enabled ?? false,
        extraJson: dto.extraJson ?? null,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.connectionRepository.create(entity, tx);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: { service, provider, tenantId: scopedTenantId, enabled: saved.enabled, action: 'connection-created' },
      });
      return AiProviderConnectionDtoMapper.toResponse(saved);
    }

    if (ev === undefined) {
      // A CAS update without a token cannot be verified. The gateway's
      // `@RequiresIfMatch()` 428s before this; this covers off-route callers.
      throw new OptimisticConcurrencyException('AiProviderConnection', existing.id, {
        expectedVersion: ev,
        currentVersion: existing.version,
      });
    }
    if (ev !== existing.version) {
      // Fast-fail the CAS against the row just read, BEFORE any Vault call —
      // `updateWithVersion` below remains the atomic backstop for races.
      throw new OptimisticConcurrencyException('AiProviderConnection', existing.id, {
        expectedVersion: ev,
        currentVersion: existing.version,
      });
    }

    // Encrypt only when the caller actually supplied a key; omitting `apiKey`
    // leaves the stored ciphertext untouched (rotate vs. edit-other-fields).
    const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;

    const changes: Record<string, unknown> = {};
    if (dto.baseUrl !== undefined) changes.baseUrl = dto.baseUrl;
    if (dto.region !== undefined) changes.region = dto.region;
    if (dto.apiVersion !== undefined) changes.apiVersion = dto.apiVersion;
    if (dto.deploymentName !== undefined) changes.deploymentName = dto.deploymentName;
    if (dto.enabled !== undefined) changes.enabled = dto.enabled;
    if (dto.extraJson !== undefined) changes.extraJson = dto.extraJson;
    if (secret) {
      changes.encryptedApiKey = secret.ciphertext;
      changes.keyVersion = secret.keyVersion;
    }

    await this.updateEntity(existing, changes);
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = existing.version;
    const updated = await this.connectionRepository.updateWithVersion(existing.id, existing, ev, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        service,
        provider,
        tenantId: scopedTenantId,
        previousVersion,
        newVersion: updated.version,
        // Record THAT the key rotated, never the key itself.
        action: secret ? 'connection-key-rotated' : 'connection-updated',
      },
    });
    return AiProviderConnectionDtoMapper.toResponse(updated);
  }

  async deleteRow(service: ProviderService, provider: string, tenantId?: string, _expectedVersion?: number): Promise<void> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    this.assertWriteAllowed(service, provider, scopedTenantId);

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantServiceProvider(service, provider, scopedTenantId, tx);
    if (!existing) {
      // An absent row is a 404, matching the frozen contract and the
      // `TenantTtsConfigService.removeCredential` precedent. A cross-tenant row
      // reads as absent through the scope extension, so the same 404 hides
      // existence — the house posture, not a 400 "bad argument".
      throw new NotFoundException(`No connection row for provider '${provider}' (service '${service}').`);
    }

    // `_expectedVersion` is accepted for C2 arity; soft-delete stays version-less
    // (the HTTP `@RequiresIfMatch()` guard remains the OCC gate at the edge).
    // `softDelete(id, updatedBy)` takes no tx client — it writes through the
    // extended client, relying on the SYSTEM-shared-read widening for a global
    // admin deleting a SYSTEM row under a working tenant.
    await this.connectionRepository.softDelete(existing.id, this.requestUserId ?? undefined);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: existing.id,
      data: { service, provider, tenantId: scopedTenantId, action: 'connection-deleted' },
    });
  }

  async resolveConnection(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderConnection | null> {
    const { tenantRows, systemRows, vetoed } = await this.cascadeRows(service, tenantId, provider);

    // The veto fails CLOSED: never the platform default, never another
    // provider. (A vetoed row is disabled, so the tenant branch below could
    // not match anyway — this is explicit because the SYSTEM branch could.)
    if (vetoed.has(provider)) return null;

    // A DISABLED row is treated as absent at both tiers — that is what makes
    // the shipped all-disabled seed behaviour-neutral (silent-change guard).
    const tenantRow = tenantRows.find((r) => r.enabled);
    if (tenantRow) return this.toResolved(tenantRow, 'tenant');
    const systemRow = systemRows.find((r) => r.enabled);
    if (systemRow) return this.toResolved(systemRow, 'system');
    return null;
  }

  async findRow(service: ProviderService, provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null> {
    const tx = this.crossTenantLane(tenantId);
    return this.connectionRepository.findByTenantServiceProvider(service, provider, tenantId, tx);
  }

  /**
   * The BYO injection resolver for one service (see the interface for the full
   * contract). Mirrors `TenantTtsConfigService.resolveProviderOverrides` with
   * ONE deliberate improvement: the per-credential catch is not silent.
   *
   * The 1-arg overload is a `@deprecated` transition shim (assumes
   * `service='llm'`) so smr-proxy keeps compiling until it
   * repoints to the service-first form.
   */
  async resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<ResolvedProviderOverrides>;
  /** @deprecated 1-arg form assumes `service='llm'`; kept for the smr-proxy transition (removes it). */
  async resolveTenantCloudOverrides(tenantId: string): Promise<ResolvedProviderOverrides>;
  async resolveTenantCloudOverrides(a: ProviderService | string, b?: string): Promise<ResolvedProviderOverrides> {
    const service = (b === undefined ? 'llm' : a) as ProviderService;
    const tenantId = b === undefined ? a : b;

    // No Transit provider → nothing is decryptable. The WRITE path already
    // rejects key writes without Vault, so this is a degraded-runtime case,
    // not a policy decision: resolve to nothing and let SYSTEM/env serve.
    if (!this.secretsService) return { overrides: {} };

    const { tenantRows, systemRows, vetoed, platformDefault } = await this.cascadeRows(service, tenantId);

    const overrides: ProviderOverrides = {};
    // SYSTEM first, then the tenant's own rows OVER it — the merge is per
    // provider KEY, never a whole-map "tenant if non-empty" short-circuit, so a
    // tenant with an azure key but no sarvam key still gets platform sarvam.
    for (const row of [...systemRows, ...tenantRows]) {
      // A non-listed row must never become a credential override even if one
      // exists — the BYO lane is cloud-only per-service (C5), enforced
      // independently of the write-side guard, and enforced at BOTH tiers so
      // the SYSTEM tier cannot become a back door for injecting a self-host
      // row's base_url as a credential.
      if (!isCloudByoProvider(service, row.provider)) continue;
      if (vetoed.has(row.provider)) continue;
      if (!row.enabled || !row.encryptedApiKey) continue;

      const entry = await this.toOverrideEntry(row, service);
      if (entry) overrides[row.provider] = entry;
    }

    return platformDefault ? { overrides, platformDefault } : { overrides };
  }

  /**
   * F-028 — restore a soft-deleted tombstone and overwrite every field from the
   * create-intent request, exactly as a fresh `create()` would populate them (an
   * omitted `apiKey` means NO key material on the revived row). CAS-gated against
   * the tombstone's OWN current version (never `dto.expectedVersion`, which the
   * caller only knows as `0`), so a concurrent revive still throws
   * `OptimisticConcurrencyException` via `updateWithVersion`.
   */
  private async restoreAndOverwrite(
    deleted: AiProviderConnectionEntity,
    dto: UpsertAiProviderConnectionRequest,
    service: ProviderService,
    provider: string,
    scopedTenantId: string,
    tx?: CoreDatabaseService['baseClient'],
  ): Promise<AiProviderConnectionResponse> {
    const currentVersion = deleted.version;
    const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;

    deleted.enable(this.requestUserId ?? undefined);
    await this.updateEntity(deleted, {
      baseUrl: dto.baseUrl ?? null,
      region: dto.region ?? null,
      apiVersion: dto.apiVersion ?? null,
      deploymentName: dto.deploymentName ?? null,
      enabled: dto.enabled ?? false,
      extraJson: dto.extraJson ?? null,
      encryptedApiKey: secret?.ciphertext ?? null,
      keyVersion: secret?.keyVersion ?? null,
    });

    const restored = await this.connectionRepository.updateWithVersion(deleted.id, deleted, currentVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: restored.id,
      createdAt: restored.createdAt,
      data: { service, provider, tenantId: scopedTenantId, enabled: restored.enabled, action: 'connection-restored' },
    });
    return AiProviderConnectionDtoMapper.toResponse(restored);
  }

  // ─────────────────────── the two-tier cascade (R1/R4/R6) ───────────────────────

  /**
   * THE cascade. Every path that may reach the SYSTEM-tenant platform default —
   * `resolveTenantCloudOverrides` (all six production injection sites) and
   * `resolveConnection` — comes through here, so there is exactly one
   * precedence rule, one veto set and one entitlement `if` in the codebase
   * (option C).
   *
   * `provider` selects the read SHAPE, not the policy: given, both tiers are
   * read by (service, provider); omitted, both are read as whole-service maps.
   * The tier logic below is identical either way.
   *
   * ORDERING IS DELIBERATE, and it is what keeps the change cheap and safe:
   *   1. the caller's own tier is read FIRST and UNCONDITIONALLY;
   *   2. the veto set is computed from it;
   *   3. the entitlement gate is evaluated;
   *   4. only then is the SYSTEM tier read.
   * A tenant that is vetoing or unentitled therefore costs exactly ONE query —
   * the same as before this ticket — and the platform's ciphertext is never
   * fetched for a caller that may not use it.
   *
   * TENANT SAFETY: the only two `tenantId` values that may appear in either
   * read are the caller's and SYSTEM. Both reads stay EXPLICITLY pinned, which
   * matters because on the `crossTenantLane` base-client path that predicate is
   * the only tenant boundary there is (the base client also skips the
   * soft-delete filter). Asserted by `tests/cross-tenant/task-643-*`.
   */
  private async cascadeRows(
    service: ProviderService,
    tenantId: string,
    provider?: string,
  ): Promise<{
    tenantRows: AiProviderConnectionEntity[];
    systemRows: AiProviderConnectionEntity[];
    vetoed: Set<string>;
    platformDefault?: PlatformDefaultOutcome;
  }> {
    const tenantRows = await this.readTier(service, tenantId, provider);

    // R4 — a tenant-owned row that is DISABLED is a VETO of this
    // (service, provider), not merely "unused": fail closed, never fall through
    // to the platform default and never to a different provider. Scoped to
    // cloud BYO providers because those are the only ones a tenant may own.
    // NOTE: a row the tenant SOFT-DELETED is invisible to the repository and so
    // reads as absent — deleting is how a tenant returns to "no opinion",
    // disabling is how it refuses.
    const vetoed = new Set(tenantRows.filter((r) => !r.enabled && isCloudByoProvider(service, r.provider)).map((r) => r.provider));

    // The caller IS the platform tier; there is nothing above it to cascade to
    // (and no gate — the SYSTEM tenant does not need permission to spend the
    // platform's own money).
    if (tenantId === SYSTEM_TENANT_ID) {
      return { tenantRows, systemRows: [], vetoed };
    }

    // A single vetoed provider makes the SYSTEM read pointless for the
    // by-provider shape: skip it rather than fetch a secret we must discard.
    if (provider !== undefined && vetoed.has(provider)) {
      return { tenantRows, systemRows: [], vetoed, platformDefault: { entitlementSuppressed: false, vetoed: [...vetoed] } };
    }

    // R6 — the gate, evaluated BEFORE the SYSTEM read. It governs platform
    // SPEND, so it applies to cloud BYO providers only: a SYSTEM row for a
    // self-host engine records where platform INFRASTRUCTURE lives and must
    // stay resolvable for every tenant, entitled or not.
    const gated = provider === undefined || isCloudByoProvider(service, provider);
    if (gated && !(await this.mayConsumePlatformDefault(tenantId))) {
      return { tenantRows, systemRows: [], vetoed, platformDefault: { entitlementSuppressed: true, vetoed: [...vetoed] } };
    }

    const systemRows = await this.readTier(service, SYSTEM_TENANT_ID, provider);
    const platformDefault = vetoed.size > 0 ? { entitlementSuppressed: false, vetoed: [...vetoed] } : undefined;
    return { tenantRows, systemRows, vetoed, platformDefault };
  }

  /**
   * One tier of the cascade, always pinned to exactly one `tenantId`. The lane
   * selection is per tier and unchanged from the single-tier code: a global
   * admin reading another tenant gets the unscoped base client (the explicit
   * predicate still bounds it), everyone else goes through the extended client,
   * where `mergeSharedReadTenantIntoWhere` permits an explicit SYSTEM pin from
   * any tenant's CLS — which is precisely the widening this model was added to
   * `SYSTEM_SHARED_READ_MODELS` for.
   */
  private async readTier(service: ProviderService, tenantId: string, provider?: string): Promise<AiProviderConnectionEntity[]> {
    const tx = this.crossTenantLane(tenantId);
    if (provider === undefined) {
      return this.connectionRepository.findByTenantIdAndService(service, tenantId, tx);
    }
    const row = await this.connectionRepository.findByTenantServiceProvider(service, provider, tenantId, tx);
    return row ? [row] : [];
  }

  /**
   * R6 — may this tenant draw on the SYSTEM-tenant platform default?
   *
   * Non-throwing by design: at cascade time nobody knows which provider the
   * request will select, so throwing here would 403 a tenant that was about to
   * use a self-hosted provider. The throw belongs at selection —
   * `assertProviderAvailable`.
   *
   * With NO entitlements service wired this DENIES. A gate that fails open is
   * not a gate, and the failure mode it would protect against is spending the
   * platform's money; denying merely reproduces the pre-cascade behaviour.
   */
  private async mayConsumePlatformDefault(tenantId: string): Promise<boolean> {
    if (!this.entitlementsService) return false;
    return this.entitlementsService.isFeatureEnabled(tenantId, 'platformDefaultCredential');
  }

  /**
   * THE ONLY construction site of a `ProviderOverrideEntry` — deliberately, and
   * this is the point of the whole R3/R1 seam.
   *
   * `funding` is DERIVED from the row that supplied the credential, never
   * passed in and never stamped afterwards, because a stamp is something a call
   * site can forget: an unstamped platform entry defaults to `tenant` and
   * produces a perfectly self-consistent `BYOK` + `BYOK_NOTIONAL` pair — the
   * ledger's consistency guard stays silent, shadow metering (which filters to
   * CLOUD) drops the event, and the call is invoiced exactly as wrongly as
   * before. Derivation removes the class of bug rather than the instance.
   *
   * Returns `null` on a decrypt failure: FAIL OPEN for that one credential (a
   * fault, never a veto), logging the identifying facts and NOTHING else — no
   * ciphertext, no plaintext, and deliberately not the error message either (a
   * Transit error string can echo the payload it choked on).
   */
  private async toOverrideEntry(row: AiProviderConnectionEntity, service: ProviderService): Promise<ProviderOverrideEntry | null> {
    if (!this.secretsService || !row.encryptedApiKey) return null;
    try {
      const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
      const entry: ProviderOverrideEntry = { api_key: apiKey, funding: this.fundingOf(row) };
      if (row.baseUrl) entry.base_url = row.baseUrl;
      if (row.region) entry.region = row.region;
      if (row.apiVersion) entry.api_version = row.apiVersion;
      if (row.deploymentName) entry.deployment_name = row.deploymentName;
      // Columns cover azure/bedrock; the newer providers keep their per-request
      // target in extraJson (console-written): `model` (openai/anthropic/stt),
      // `project`/`location` (vertex). Without this, Vertex BYO never reaches
      // the tenant's project and an LLM model override is silently dropped.
      // `foundryModel` is the pre-unification spelling of `model` on STT rows;
      // reading it here is what lets a SYSTEM-sourced STT entry keep its model
      // id (the caller-side `list()` fold that used to supply it is
      // tenant-pinned and cannot see the platform row).
      const extra = (row.extraJson ?? {}) as Record<string, unknown>;
      const model = extra.model ?? extra.foundryModel;
      if (typeof model === 'string' && model.length > 0) entry.model = model;
      if (typeof extra.project === 'string') entry.project = extra.project;
      if (typeof extra.location === 'string') entry.location = extra.location;
      return entry;
    } catch {
      this.logger.warn({
        message: 'Provider credential failed to decrypt; skipping (the other tier/credentials still resolve)',
        tenantId: row.tenantId,
        service,
        provider: row.provider,
        keyVersion: row.keyVersion ?? null,
      });
      return null;
    }
  }

  /** Funding is a pure function of WHOSE row supplied the credential. */
  private fundingOf(row: AiProviderConnectionEntity): ProviderFunding {
    return row.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant';
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The two privilege boundaries. Both throw 403 rather than 404: the caller is
   * acting on its OWN tenant, so there is nothing to hide — the rule is "you may
   * not do this", not "this may not exist". Mirrors
   * `AiTaskDefaultService.upsertRow`'s SUPER_ADMIN_ONLY guard.
   */
  private assertWriteAllowed(service: ProviderService, provider: string, targetTenantId: string): void {
    if (targetTenantId === SYSTEM_TENANT_ID) {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('Platform provider connections are managed by super administrators only.');
      }
      return;
    }

    if (!isCloudByoProvider(service, provider)) {
      throw new ForbiddenException(
        `Provider '${provider}' is not a tenant-managed cloud provider for the '${service}' capability; ` +
          'its connection is managed at the platform level only.',
      );
    }
  }

  private async encryptKey(plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: number }> {
    // Two DISTINCT "no Vault" shapes, and only one of them is a transient
    // outage: `!this.secretsService` is the theoretical case where the module
    // never provided SecretsService at all, but in this app it is always
    // injected — SECRETS_PROVIDER=env/aws/azure/in-memory still constructs a
    // real instance whose `.encrypt()` throws a capability-guard `Error` (see
    // `SecretsService.encrypt`). Without this `supportsTransit()` check that
    // guard error fell into the generic catch below and was misreported as a
    // 503 "temporarily unavailable, retry" — but a non-vault provider is a
    // permanent configuration state, not a transient Transit outage. The 400
    // branch below is the one path a caller can't fix by retrying.
    if (!this.secretsService || !this.secretsService.supportsTransit()) {
      throw new BadRequestException(
        'Provider API keys require the Vault secrets provider (SECRETS_PROVIDER=vault). ' + 'There is no plaintext-at-rest fallback.',
      );
    }
    try {
      return await encryptSecretField(this.secretsService, plaintext);
    } catch (err) {
      // A genuine Transit call failure (Vault sealed/unreachable) IS a
      // dependency outage, not an internal fault: map to 503 so the client
      // retries rather than filing a 500. Never log or echo the plaintext.
      this.logger.warn(`Transit encryption unavailable for provider-key write: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException(
        'Secret encryption is temporarily unavailable; the key was not stored. Retry once Vault Transit is reachable.',
      );
    }
  }

  private toResolved(entity: AiProviderConnectionEntity, source: 'tenant' | 'system'): ResolvedProviderConnection {
    return {
      service: entity.service as ProviderService,
      provider: entity.provider,
      baseUrl: entity.baseUrl ?? null,
      region: entity.region ?? null,
      apiVersion: entity.apiVersion ?? null,
      deploymentName: entity.deploymentName ?? null,
      encryptedApiKey: entity.encryptedApiKey ?? null,
      keyVersion: entity.keyVersion ?? null,
      source,
    };
  }

  /** See `AiTaskDefaultService.crossTenantLane` for the full rationale. */
  private crossTenantLane(targetTenantId: string): CoreDatabaseService['baseClient'] | undefined {
    if (targetTenantId !== this.tenantId && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }

  private resolveScopedTenantId(tenantId?: string): string {
    const scoped = tenantId ?? this.tenantId;
    if (!scoped) {
      throw new BadRequestException('Tenant ID is required');
    }
    return scoped;
  }
}
