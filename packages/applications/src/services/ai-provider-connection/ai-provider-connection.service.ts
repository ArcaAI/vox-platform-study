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
import {
  IAiProviderConnectionService,
  LlmProviderOverrideEntry,
  LlmProviderOverrides,
  ResolvedProviderConnection,
} from './IAiProviderConnectionService';
import { AiProviderConnectionDtoMapper } from './ai-provider-connection.dto.mapper';
import { isCloudByoProvider } from './constants';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

/**
 * TASK-524 — provider-connection service (GAP-C1).
 *
 * Owns WHERE a serving provider lives and HOW to authenticate to it, as the
 * DB control plane replacing per-service env configuration.
 *
 * TWO privilege boundaries, both 403 (NOT the 404-over-403 cross-tenant
 * posture — these are rules about the caller's OWN tenant, not existence
 * probes on someone else's):
 *   - a TENANT row is permitted only for a cloud BYO provider (azure/bedrock);
 *     self-host engine endpoints are platform infrastructure;
 *   - a SYSTEM row may be written only by a global admin.
 *
 * Secrets travel through `encryptSecretField` exclusively; there is no
 * plaintext-at-rest fallback (a key write is REJECTED when Vault is absent,
 * mirroring `TenantTtsConfigService.setCredential`), and no read path — and no
 * route at all — ever returns the ciphertext.
 */
@Injectable()
export class AiProviderConnectionService extends BaseService implements IAiProviderConnectionService {
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

  async list(tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const rows = await this.connectionRepository.findByTenantId(scopedTenantId, tx);
    return rows.map((r) => AiProviderConnectionDtoMapper.toResponse(r));
  }

  async getRow(provider: string, tenantId?: string): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const row = await this.connectionRepository.findByTenantAndProvider(scopedTenantId, provider, tx);
    return row ? AiProviderConnectionDtoMapper.toResponse(row) : AiProviderConnectionDtoMapper.placeholder(scopedTenantId, provider);
  }

  async upsertRow(provider: string, dto: UpsertAiProviderConnectionRequest, tenantId?: string): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    this.assertWriteAllowed(provider, scopedTenantId);

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantAndProvider(scopedTenantId, provider, tx);

    if (!existing) {
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('AiProviderConnection', `${scopedTenantId}:${provider}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      // Encrypt only when the caller actually supplied a key — and only AFTER
      // the precondition verdict above (TASK-534 e2e G3: encrypting first
      // turned a stale-If-Match 412 into a 500 whenever Transit was down).
      const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;
      const entity = AiProviderConnectionFactory.CreateAiProviderConnection({
        tenantId: scopedTenantId,
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
        data: { provider, tenantId: scopedTenantId, enabled: saved.enabled, action: 'connection-created' },
      });
      return AiProviderConnectionDtoMapper.toResponse(saved);
    }

    if (dto.expectedVersion === undefined) {
      // A CAS update without a token cannot be verified. The gateway's
      // `@RequiresIfMatch()` 428s before this; this covers off-route callers.
      throw new OptimisticConcurrencyException('AiProviderConnection', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }
    if (dto.expectedVersion !== existing.version) {
      // Fast-fail the CAS against the row just read, BEFORE any Vault call —
      // `updateWithVersion` below remains the atomic backstop for races.
      // (TASK-534 e2e G3: pre-fix, a stale precondition with an `apiKey` in the
      // body reached Transit first and surfaced as a 500 when Vault was down.)
      throw new OptimisticConcurrencyException('AiProviderConnection', existing.id, {
        expectedVersion: dto.expectedVersion,
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
    const updated = await this.connectionRepository.updateWithVersion(existing.id, existing, dto.expectedVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
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

  async deleteRow(provider: string, tenantId?: string): Promise<void> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    this.assertWriteAllowed(provider, scopedTenantId);

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantAndProvider(scopedTenantId, provider, tx);
    if (!existing) {
      // TASK-526: an absent row is a 404, matching the frozen §3.6 contract and
      // the `TenantTtsConfigService.removeCredential` precedent. A cross-tenant
      // row reads as absent through the scope extension, so the same 404 hides
      // existence — the house posture, not a 400 "bad argument".
      throw new NotFoundException(`No connection row for provider '${provider}'.`);
    }

    // `softDelete(id, updatedBy)` takes no tx client — it writes through the
    // extended client. A global admin soft-deleting a SYSTEM row while acting
    // under a working tenant therefore relies on the SYSTEM-shared-read
    // widening; the same limitation applies to every soft-delete in the repo.
    await this.connectionRepository.softDelete(existing.id, this.requestUserId ?? undefined);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: existing.id,
      data: { provider, tenantId: scopedTenantId, action: 'connection-deleted' },
    });
  }

  async resolveConnection(provider: string, tenantId: string): Promise<ResolvedProviderConnection | null> {
    const tx = this.crossTenantLane(SYSTEM_TENANT_ID);

    const [tenantRow, systemRow] = await Promise.all([
      tenantId === SYSTEM_TENANT_ID ? Promise.resolve(null) : this.connectionRepository.findByTenantAndProvider(tenantId, provider, tx),
      this.connectionRepository.findByTenantAndProvider(SYSTEM_TENANT_ID, provider, tx),
    ]);

    // A DISABLED row is treated as absent — that is what makes the shipped
    // all-disabled seed behaviour-neutral (ticket §7 silent-change guard).
    if (tenantRow?.enabled) return this.toResolved(tenantRow, 'tenant');
    if (systemRow?.enabled) return this.toResolved(systemRow, 'system');
    return null;
  }

  async findRow(provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null> {
    const tx = this.crossTenantLane(tenantId);
    return this.connectionRepository.findByTenantAndProvider(tenantId, provider, tx);
  }

  /**
   * TASK-526 — the BYO injection resolver (see the interface for the full
   * contract). Mirrors `TenantTtsConfigService.resolveProviderOverrides` with
   * ONE deliberate improvement: the per-credential catch is not silent.
   */
  async resolveTenantCloudOverrides(tenantId: string): Promise<LlmProviderOverrides> {
    // No Transit provider → nothing is decryptable. The WRITE path already
    // rejects key writes without Vault, so this is a degraded-runtime case,
    // not a policy decision: resolve to nothing and let SYSTEM/env serve.
    if (!this.secretsService) return {};

    const tx = this.crossTenantLane(tenantId);
    const rows = await this.connectionRepository.findByTenantId(tenantId, tx);

    const out: LlmProviderOverrides = {};
    for (const row of rows) {
      // A self-host row must never become a credential override even if one
      // exists — the tenant lane is cloud-only (AD-2), enforced independently
      // of the write-side guard.
      if (!isCloudByoProvider(row.provider)) continue;
      if (!row.enabled || !row.encryptedApiKey) continue;

      try {
        const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
        const entry: LlmProviderOverrideEntry = { api_key: apiKey };
        if (row.baseUrl) entry.base_url = row.baseUrl;
        if (row.region) entry.region = row.region;
        if (row.apiVersion) entry.api_version = row.apiVersion;
        if (row.deploymentName) entry.deployment_name = row.deploymentName;
        out[row.provider] = entry;
      } catch {
        // FAIL OPEN for this one credential. The log carries the three
        // identifying facts and NOTHING else — no ciphertext, no plaintext, and
        // deliberately not the error message either (a Transit error string can
        // echo the payload it choked on).
        this.logger.warn({
          message: 'Tenant provider credential failed to decrypt; skipping (request falls back to platform credentials)',
          tenantId,
          provider: row.provider,
          keyVersion: row.keyVersion ?? null,
        });
      }
    }
    return out;
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The two privilege boundaries. Both throw 403 rather than 404: the caller is
   * acting on its OWN tenant, so there is nothing to hide — the rule is "you
   * may not do this", not "this may not exist". Mirrors
   * `AiTaskDefaultService.upsertRow`'s GLOBAL_ADMIN_ONLY guard.
   */
  private assertWriteAllowed(provider: string, targetTenantId: string): void {
    if (targetTenantId === SYSTEM_TENANT_ID) {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('Platform provider connections are managed by global administrators only.');
      }
      return;
    }

    if (!isCloudByoProvider(provider)) {
      throw new ForbiddenException(
        `Provider '${provider}' is a self-hosted engine; its connection is managed at the platform level only. ` +
          'Tenant-owned connections are available for cloud API providers.',
      );
    }
  }

  private async encryptKey(plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: number }> {
    if (!this.secretsService) {
      throw new BadRequestException(
        'Provider API keys require the Vault secrets provider (SECRETS_PROVIDER=vault). ' + 'There is no plaintext-at-rest fallback.',
      );
    }
    try {
      return await encryptSecretField(this.secretsService, plaintext);
    } catch (err) {
      // TASK-534 e2e G3 — a Transit failure (Vault down / provider without
      // Transit support) is a dependency outage, not an internal fault: map to
      // 503 so the client retries rather than filing a 500. Never log or echo
      // the plaintext.
      this.logger.warn(`Transit encryption unavailable for provider-key write: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException(
        'Secret encryption is temporarily unavailable; the key was not stored. Retry once Vault Transit is reachable.',
      );
    }
  }

  private toResolved(entity: AiProviderConnectionEntity, source: 'tenant' | 'system'): ResolvedProviderConnection {
    return {
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
