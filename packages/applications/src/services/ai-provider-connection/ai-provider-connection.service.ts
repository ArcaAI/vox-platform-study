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
import { IProviderConnectionService, ProviderOverrideEntry, ProviderOverrides, ResolvedProviderConnection } from './IProviderConnectionService';
import { AiProviderConnectionDtoMapper } from './ai-provider-connection.dto.mapper';
import { ProviderService, isCloudByoProvider } from './constants';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

/**
 * Unified provider-connection service (TASK-569).
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
 *   - a SYSTEM row may be written only by a global admin.
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
    // `AiTaskDefaultService`) — a global admin acting under working tenant W
    // must be able to read/write SYSTEM and foreign-tenant rows.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so non-Vault deploys still run; key writes then reject.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
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
    const tx = this.crossTenantLane(SYSTEM_TENANT_ID);

    const [tenantRow, systemRow] = await Promise.all([
      tenantId === SYSTEM_TENANT_ID ? Promise.resolve(null) : this.connectionRepository.findByTenantServiceProvider(service, provider, tenantId, tx),
      this.connectionRepository.findByTenantServiceProvider(service, provider, SYSTEM_TENANT_ID, tx),
    ]);

    // A DISABLED row is treated as absent — that is what makes the shipped
    // all-disabled seed behaviour-neutral (silent-change guard).
    if (tenantRow?.enabled) return this.toResolved(tenantRow, 'tenant');
    if (systemRow?.enabled) return this.toResolved(systemRow, 'system');
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
   * `service='llm'`) so the TASK-572-owned smr-proxy keeps compiling until it
   * repoints to the service-first form.
   */
  async resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<ProviderOverrides>;
  /** @deprecated 1-arg form assumes `service='llm'`; kept for the smr-proxy transition (TASK-572 removes it). */
  async resolveTenantCloudOverrides(tenantId: string): Promise<ProviderOverrides>;
  async resolveTenantCloudOverrides(a: ProviderService | string, b?: string): Promise<ProviderOverrides> {
    const service = (b === undefined ? 'llm' : a) as ProviderService;
    const tenantId = b === undefined ? a : b;

    // No Transit provider → nothing is decryptable. The WRITE path already
    // rejects key writes without Vault, so this is a degraded-runtime case,
    // not a policy decision: resolve to nothing and let SYSTEM/env serve.
    if (!this.secretsService) return {};

    const tx = this.crossTenantLane(tenantId);
    const rows = await this.connectionRepository.findByTenantIdAndService(service, tenantId, tx);

    const out: ProviderOverrides = {};
    for (const row of rows) {
      // A non-listed row must never become a credential override even if one
      // exists — the tenant lane is cloud-only per-service (C5), enforced
      // independently of the write-side guard.
      if (!isCloudByoProvider(service, row.provider)) continue;
      if (!row.enabled || !row.encryptedApiKey) continue;

      try {
        const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
        const entry: ProviderOverrideEntry = { api_key: apiKey };
        if (row.baseUrl) entry.base_url = row.baseUrl;
        if (row.region) entry.region = row.region;
        if (row.apiVersion) entry.api_version = row.apiVersion;
        if (row.deploymentName) entry.deployment_name = row.deploymentName;
        // Columns cover azure/bedrock; the newer providers keep their per-request
        // target in extraJson (console-written): `model` (openai/anthropic/stt),
        // `project`/`location` (vertex). Without this, Vertex BYO never reaches
        // the tenant's project and an LLM model override is silently dropped.
        const extra = (row.extraJson ?? {}) as Record<string, unknown>;
        if (typeof extra.model === 'string') entry.model = extra.model;
        if (typeof extra.project === 'string') entry.project = extra.project;
        if (typeof extra.location === 'string') entry.location = extra.location;
        out[row.provider] = entry;
      } catch {
        // FAIL OPEN for this one credential. The log carries the identifying
        // facts and NOTHING else — no ciphertext, no plaintext, and deliberately
        // not the error message either (a Transit error string can echo the
        // payload it choked on).
        this.logger.warn({
          message: 'Tenant provider credential failed to decrypt; skipping (request falls back to platform credentials)',
          tenantId,
          service,
          provider: row.provider,
          keyVersion: row.keyVersion ?? null,
        });
      }
    }
    return out;
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

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The two privilege boundaries. Both throw 403 rather than 404: the caller is
   * acting on its OWN tenant, so there is nothing to hide — the rule is "you may
   * not do this", not "this may not exist". Mirrors
   * `AiTaskDefaultService.upsertRow`'s GLOBAL_ADMIN_ONLY guard.
   */
  private assertWriteAllowed(service: ProviderService, provider: string, targetTenantId: string): void {
    if (targetTenantId === SYSTEM_TENANT_ID) {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('Platform provider connections are managed by global administrators only.');
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
