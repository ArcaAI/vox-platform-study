import {
  BadRequestException,
  ConflictException,
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
  AiModelEntity,
  AiModelFactory,
  AiModelRepository,
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
  ResolvedProviderCredential,
  ResolvedProviderOverrides,
} from './IProviderConnectionService';
import { AiProviderConnectionDtoMapper } from './ai-provider-connection.dto.mapper';
import {
  BYO_DECLARABLE_SERVICES,
  ByoDeclarableService,
  ByoModelDeclaration,
  buildByoModelProps,
  byoModelSlug,
  isByoDeclarableService,
  isTaskTypeOfService,
  suggestedByoModelSlug,
  taskTypesOfService,
} from './byo-model-declaration';
import { PROVIDER_SERVICES, ProviderService, isCloudByoProvider } from './constants';
import { AiProviderConnectionResponse, DeclareConnectionModelsRequest, UpsertAiProviderConnectionRequest } from './dto';
import { sanitizeProviderExtras } from './provider-extras';
import { ConnectionRequirementSubject, validateProviderRequirements } from './provider-requirements';

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
    // TASK-890 §3.7a — the registry rows a BYO declaration MATERIALISES. The
    // repository, not `AiModelService`: that service's whole surface is
    // SYSTEM-pinned behind `assertPlatformAdmin` (REQ-5 — the registry stays
    // platform-only), and injecting it would also close a DI cycle, since it
    // already injects this service for the catalogue's connection facts.
    // `@Optional()` and TRAILING so every existing positional fixture keeps its
    // arity; an ABSENT repository makes `declareModels` fail closed rather than
    // silently succeed having written nothing.
    @Optional() private readonly aiModelRepository?: AiModelRepository,
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
    if (!row) return { ...AiProviderConnectionDtoMapper.placeholder(service, scopedTenantId, provider), models: [] };
    // TASK-890 §3.7a — the single-row read carries the models declared on it, so
    // the console edits credential and model list from ONE payload.
    return AiProviderConnectionDtoMapper.toResponse(row, await this.declaredModels(row, scopedTenantId, tx));
  }

  /**
   * TASK-890 §3.7a (OD-A) — DECLARE the models this tenant's connection serves.
   *
   * The one act a BYO tenant actually performs: "here is my Azure resource, and
   * here are the deployments on it". Each entry becomes a TENANT-OWNED `AiModel`
   * row stamped with `sourceConnectionId`, which is what makes it visible in
   * that tenant's catalogue (under `byo:<service>:<provider>`), bindable by an
   * agent, and invisible to every other tenant.
   *
   * FIVE properties this method must keep:
   *
   *  1. **It is a full REPLACEMENT.** The list is the fact; an entry that leaves
   *     it is soft-deleted (never hard-deleted — an agent's FK is `Restrict`,
   *     and its next publish failing observably beats a binding that vanished).
   *  2. **Nothing is written until everything validates**, including the
   *     slug-shadow check. A half-applied declaration would leave the tenant's
   *     list and its rows disagreeing, which is the one state the replacement
   *     semantics exist to prevent.
   *  3. **A generated slug may never shadow a SYSTEM slug** (P-29, §2.7 #25):
   *     `AiModel` uniqueness is `(tenantId, slug)` and every by-slug resolver
   *     prefers the caller's own row, so a `azure-gpt-4o-mini` tenant row would
   *     silently replace the platform's row of that name for that tenant. 409,
   *     naming the platform row and a `byo-` prefixed suggestion.
   *  4. **It never asks for platform admin.** REQ-5 keeps the REGISTRY
   *     (`/admin/ai-models`) platform-only; a tenant declaring its own vendor's
   *     models is the tenant-admin act this ticket exists to enable.
   *  5. **The SYSTEM tier is refused here**, even for a super admin, and says
   *     where platform models are declared instead — one home per fact.
   */
  async declareModels(
    service: ProviderService,
    provider: string,
    dto: DeclareConnectionModelsRequest,
    tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    if (scopedTenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('Platform models are declared in /admin/ai-models; a SYSTEM connection declares none.');
    }
    // The SAME class gate as every other write on this row: a provider the
    // tenant may not hold a connection for cannot be given models either.
    this.assertWriteAllowed(service, provider, scopedTenantId);
    if (!isByoDeclarableService(service)) {
      throw new BadRequestException(
        `The '${service}' capability serves no per-tenant model rows. Declarable services: ${BYO_DECLARABLE_SERVICES.join(', ')}.`,
      );
    }
    if (!this.aiModelRepository) {
      throw new ServiceUnavailableException('The model registry is unavailable; models cannot be declared right now.');
    }

    const tx = this.crossTenantLane(scopedTenantId);
    const connection = await this.connectionRepository.findByTenantServiceProvider(service, provider, scopedTenantId, tx);
    if (!connection) {
      throw new NotFoundException(
        `No connection row for provider '${provider}' (service '${service}'). Save the connection before declaring its models.`,
      );
    }

    const entries = this.validateDeclaration(service, provider, dto);

    // (3) The shadow check runs over EVERY entry before any write.
    for (const entry of entries) {
      const shadowed = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, entry.slug, this.databaseService.baseClient);
      if (shadowed) {
        throw new ConflictException({
          code: 'BYO_SLUG_SHADOWS_PLATFORM',
          message:
            `A platform model already uses the name '${entry.slug}'. Declaring it here would shadow that model for your ` +
            `tenant everywhere it is resolved by name. Re-send this entry with slug '${entry.suggestedSlug}' to keep both.`,
          slug: entry.slug,
          systemModelId: shadowed.id,
          suggestedSlug: entry.suggestedSlug,
        });
      }
    }

    const existing = await this.aiModelRepository.findBySourceConnection(connection.id, scopedTenantId, tx);
    const bySlug = new Map(existing.map((row) => [row.slug, row]));
    const userId = this.requestUserId ?? undefined;
    const kept: AiModelEntity[] = [];
    let created = 0;
    let updated = 0;

    for (const entry of entries) {
      const current = bySlug.get(entry.slug);
      if (current) {
        bySlug.delete(entry.slug);
        const changed = this.applyDeclaration(current, entry.declaration, userId);
        if (changed) {
          current.validate();
          kept.push(await this.aiModelRepository.update(current.id, current, tx));
          updated += 1;
        } else {
          kept.push(current);
        }
        continue;
      }
      // A model this connection declared BEFORE and then withdrew is REVIVED, not re-created.
      // Withdrawal is a soft delete and `(tenantId, slug)` is unique across every status, so
      // creating here raced the tombstone and answered a raw `P2002` — "Unique constraint
      // violation", with no name and no remedy — for the ordinary act of putting a model back.
      const withdrawn = await this.aiModelRepository.findBySlugIncludingDeleted(scopedTenantId, entry.slug, tx ?? this.databaseService.baseClient);
      if (withdrawn) {
        if (withdrawn.sourceConnectionId !== connection.id) {
          // A different connection of the same tenant owns that name. Named, not raw: the
          // remedy is to withdraw it there or declare this one under the `byo-` suggestion.
          throw new ConflictException({
            code: 'BYO_SLUG_IN_USE',
            message:
              `This tenant already has a model named '${entry.slug}' declared on another provider connection. ` +
              `Withdraw it there, or re-send this entry with slug '${entry.suggestedSlug}'.`,
            slug: entry.slug,
            suggestedSlug: entry.suggestedSlug,
          });
        }
        await this.aiModelRepository.restore(withdrawn.id, userId, tx);
        this.applyDeclaration(withdrawn, entry.declaration, userId);
        withdrawn.validate();
        kept.push(withdrawn.hasChanges ? await this.aiModelRepository.update(withdrawn.id, withdrawn, tx) : withdrawn);
        updated += 1;
        continue;
      }

      const model = AiModelFactory.CreateAiModel(
        buildByoModelProps({
          service: service as ByoDeclarableService,
          provider,
          tenantId: scopedTenantId,
          connectionId: connection.id,
          slug: entry.slug,
          entry: entry.declaration,
          ...(userId ? { createdBy: userId } : {}),
        }),
      );
      model.validate();
      kept.push(await this.aiModelRepository.create(model, tx));
      created += 1;
    }

    // (1) Whatever is left over left the list.
    const removed = [...bySlug.values()];
    for (const row of removed) {
      await this.aiModelRepository.softDelete(row.id, userId, tx);
    }

    await this.syncSingleModelExtra(connection, service, kept, tx);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: connection.id,
      data: {
        service,
        provider,
        tenantId: scopedTenantId,
        action: 'connection-models-declared',
        created,
        updated,
        removed: removed.length,
      },
    });

    return AiProviderConnectionDtoMapper.toResponse(connection, kept);
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

      // Requirements BEFORE encryption, for the same reason the precondition
      // check comes before it: a row that will be refused must not spend a
      // Vault round trip, and a Transit outage must not turn a 400 into a 500.
      this.assertRequirementsSatisfied(service, provider, {
        enabled: dto.enabled ?? false,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        apiVersion: dto.apiVersion ?? null,
        deploymentName: dto.deploymentName ?? null,
        hasApiKey: dto.apiKey !== undefined,
        extraJson: dto.extraJson ?? null,
      });

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
        maxConcurrent: dto.maxConcurrent ?? null,
        rpmLimit: dto.rpmLimit ?? null,
        tpmLimit: dto.tpmLimit ?? null,
        timeoutS: dto.timeoutS ?? null,
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

    // The requirement check reads the MERGED row, never the request body. A DTO
    // that changes only `deploymentName` must be judged against the endpoint,
    // api-version and key ALREADY STORED — otherwise every partial edit of a
    // complete Azure row would be refused for fields it never mentioned.
    // Symmetrically, an edit that CLEARS a required field, or flips an
    // incomplete row to `enabled`, is refused here even though the request
    // itself looks innocent.
    this.assertRequirementsSatisfied(service, provider, {
      enabled: dto.enabled ?? existing.enabled,
      baseUrl: dto.baseUrl !== undefined ? dto.baseUrl : existing.baseUrl,
      region: dto.region !== undefined ? dto.region : existing.region,
      apiVersion: dto.apiVersion !== undefined ? dto.apiVersion : existing.apiVersion,
      deploymentName: dto.deploymentName !== undefined ? dto.deploymentName : existing.deploymentName,
      // Key material the row WILL hold: the incoming key if one was supplied,
      // otherwise whatever is already stored.
      hasApiKey: dto.apiKey !== undefined || (existing.encryptedApiKey?.length ?? 0) > 0,
      extraJson: dto.extraJson !== undefined ? dto.extraJson : existing.extraJson,
    });

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
    // TASK-862 ceilings: `null` clears a cap (back to "no opinion"), omitted leaves it.
    if (dto.maxConcurrent !== undefined) changes.maxConcurrent = dto.maxConcurrent;
    if (dto.rpmLimit !== undefined) changes.rpmLimit = dto.rpmLimit;
    if (dto.tpmLimit !== undefined) changes.tpmLimit = dto.tpmLimit;
    if (dto.timeoutS !== undefined) changes.timeoutS = dto.timeoutS;
    if (secret) {
      changes.encryptedApiKey = secret.ciphertext;
      changes.keyVersion = secret.keyVersion;
    }

    await this.updateEntity(existing, changes);
    if (!existing.hasChanges) {
      // PUT is idempotent by contract (RFC 9110 §9.2.2): re-sending a value that is
      // already stored must yield the SAME observable result as the first send, not a
      // 400. Returning the current representation satisfies BOTH that and the
      // phantom-write rule — no version bump, no `updatedAt` rewrite, no
      // ResourceUpdated event. (PATCH routes keep throwing `ArgumentInvalidException`;
      // there "you sent me nothing to change" IS the documented answer.)
      // The OCC precondition above has already run, so a STALE token still gets 412
      // rather than a misleading 200.
      return AiProviderConnectionDtoMapper.toResponse(existing);
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
    // TASK-890 §3.7a — the models DECLARED on this connection go first: the
    // `AiModel.sourceConnectionId` FK is `Restrict`, so a connection may not
    // vanish under rows that still point at it, and a declared model outliving
    // its credential is a row nothing can serve.
    await this.softDeleteDeclaredModels(existing, scopedTenantId, tx);
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
   * `service='llm'`) so text-proxy keeps compiling until it
   * repoints to the service-first form.
   */
  async resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<ResolvedProviderOverrides>;
  /** @deprecated 1-arg form assumes `service='llm'`; kept for the text-proxy transition (removes it). */
  async resolveTenantCloudOverrides(tenantId: string): Promise<ResolvedProviderOverrides>;
  async resolveTenantCloudOverrides(a: ProviderService | string, b?: string): Promise<ResolvedProviderOverrides> {
    const service = (b === undefined ? 'llm' : a) as ProviderService;
    const tenantId = b === undefined ? a : b;

    // No Transit provider → nothing is decryptable. The WRITE path already
    // rejects key writes without Vault, so this is a degraded-runtime case,
    // not a policy decision: resolve to nothing and let SYSTEM/env serve.
    if (!this.secretsService) return { overrides: {} };

    const { tenantRows, systemRows, vetoed, platformDefault, systemEntitled } = await this.cascadeRows(service, tenantId);

    const overrides: ProviderOverrides = {};
    // SYSTEM first, then the tenant's own rows OVER it — the merge is per
    // provider KEY, never a whole-map "tenant if non-empty" short-circuit, so a
    // tenant with an azure key but no sarvam key still gets platform sarvam.
    for (const [tier, rows] of [
      ['system', systemRows],
      ['tenant', tenantRows],
    ] as const) {
      for (const row of rows) {
        if (vetoed.has(row.provider)) continue;
        // A keyless row carries no credential to inject, whichever tier it is
        // on. This is also what stops a SYSTEM row's `base_url` from being
        // mistaken for a credential — an entry only ever exists behind real key
        // material.
        if (!row.enabled || !row.encryptedApiKey) continue;

        const isCloud = isCloudByoProvider(service, row.provider);

        // TENANT tier: a tenant may only ever OWN a cloud BYO row (C5).
        // Enforced here as well as at the write guard, so a row that predates
        // the guard cannot become a credential override.
        if (tier === 'tenant' && !isCloud) continue;

        // SYSTEM tier: this IS the platform default. -C — the tier
        // is no longer filtered by `isCloudByoProvider`. That filter conflated
        // two different rules and broke the second one: "a TENANT may not own
        // this" is not "the PLATFORM may not serve it". A super-admin-written
        // SYSTEM row for a self-host engine (a keyed vLLM/openai-compat
        // endpoint, the TEI reranker, the platform Qdrant) is platform
        // INFRASTRUCTURE and must reach every tenant; only a CLOUD row is
        // platform SPEND, and only that is gated by R6.
        if (tier === 'system' && isCloud && !systemEntitled) continue;

        const entry = await this.toOverrideEntry(row, service);
        if (entry) overrides[row.provider] = entry;
      }
    }

    return platformDefault ? { overrides, platformDefault } : { overrides };
  }

  /**
   * F-028 — restore a soft-deleted tombstone and overwrite every field from the
   * create()-intent request, exactly as a fresh `create` would populate them (an
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

    // A revive is a FRESH write — every field below is set from the DTO with no
    // carry-over from the tombstone — so it is judged exactly like a create.
    this.assertRequirementsSatisfied(service, provider, {
      enabled: dto.enabled ?? false,
      baseUrl: dto.baseUrl ?? null,
      region: dto.region ?? null,
      apiVersion: dto.apiVersion ?? null,
      deploymentName: dto.deploymentName ?? null,
      hasApiKey: dto.apiKey !== undefined,
      extraJson: dto.extraJson ?? null,
    });

    const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;

    deleted.enable(this.requestUserId ?? undefined);
    await this.updateEntity(deleted, {
      baseUrl: dto.baseUrl ?? null,
      region: dto.region ?? null,
      apiVersion: dto.apiVersion ?? null,
      deploymentName: dto.deploymentName ?? null,
      enabled: dto.enabled ?? false,
      extraJson: dto.extraJson ?? null,
      maxConcurrent: dto.maxConcurrent ?? null,
      rpmLimit: dto.rpmLimit ?? null,
      tpmLimit: dto.tpmLimit ?? null,
      timeoutS: dto.timeoutS ?? null,
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
   *
   * PUBLIC since TASK-862 so `ProviderCredentialResolver` can build the
   * one-credential precedence rule on the SAME tier reads the request fold
   * uses. It returns ROWS (ciphertext), never plaintext — gateway-side only.
   */
  async cascadeRows(
    service: ProviderService,
    tenantId: string,
    provider?: string,
  ): Promise<{
    tenantRows: AiProviderConnectionEntity[];
    systemRows: AiProviderConnectionEntity[];
    vetoed: Set<string>;
    platformDefault?: PlatformDefaultOutcome;
    /**
     * Whether this caller may draw on the platform's VENDOR accounts. Returned
     * (rather than merely applied) because the whole-service read cannot decide
     * the question per row until it knows which rows came back — see the fold
     * in `resolveTenantCloudOverrides`.
     */
    systemEntitled: boolean;
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
    //
    // These rows are returned as `systemRows`, NOT `tenantRows` —.
    // The fold in `resolveTenantCloudOverrides` filters its 'tenant' tier to
    // `isCloudByoProvider` rows only (R4/C5: a tenant may only OWN a cloud
    // row); mislabelling SYSTEM's own rows as that tier silently dropped every
    // non-cloud, platform-managed row (`model-registry:huggingface`,
    // `model-registry:s3`, `rerank:*`, a self-host `llm`/`tts` row, ...)
    // whenever SYSTEM resolved its OWN credential — exactly the case a
    // gateway-internal caller hits when the resource it is resolving for
    // (e.g. an `AiModel` in the platform catalogue) is itself SYSTEM-owned.
    // Cloud providers were never affected: `isCloud` made the old 'tenant'-tier
    // check a no-op for them.
    if (tenantId === SYSTEM_TENANT_ID) {
      return { tenantRows: [], systemRows: tenantRows, vetoed, systemEntitled: true };
    }

    // A single vetoed provider makes the SYSTEM read pointless for the
    // by-provider shape: skip it rather than fetch a secret we must discard.
    if (provider !== undefined && vetoed.has(provider)) {
      return {
        tenantRows,
        systemRows: [],
        vetoed,
        platformDefault: { entitlementSuppressed: false, vetoed: [...vetoed] },
        systemEntitled: false,
      };
    }

    // R6 — the gate. It governs platform SPEND on a VENDOR account, so it is
    // scoped to cloud BYO providers: a SYSTEM row for a self-host engine records
    // where platform INFRASTRUCTURE lives and must stay resolvable for every
    // tenant, entitled or not. Only ASK when the answer can matter, so a
    // by-provider read for a self-host provider costs no entitlement lookup.
    const gateApplies = provider === undefined || isCloudByoProvider(service, provider);
    const systemEntitled = gateApplies ? await this.mayConsumePlatformDefault(tenantId) : true;

    // BY-PROVIDER shape, cloud provider, gate denied: skip the SYSTEM read
    // entirely — the platform's ciphertext is never even fetched for a caller
    // that may not use it.
    if (provider !== undefined && gateApplies && !systemEntitled) {
      return {
        tenantRows,
        systemRows: [],
        vetoed,
        platformDefault: { entitlementSuppressed: true, vetoed: [...vetoed] },
        systemEntitled,
      };
    }

    // WHOLE-SERVICE shape: the SYSTEM tier is read even when the gate denies,
    // because the denial is PER PROVIDER and only the rows themselves say which
    // ones it covers. -C: skipping the read wholesale also withheld
    // the platform's SELF-HOST infrastructure rows — the ones the gate was
    // never meant to touch — which is precisely why `rerank:tei` and
    // `vector:qdrant` were storable but undeliverable. Suppression is applied
    // per row in the fold, and a suppressed row is never DECRYPTED, so no
    // plaintext key material is produced for a caller that may not use it.
    const systemRows = await this.readTier(service, SYSTEM_TENANT_ID, provider);
    const entitlementSuppressed = gateApplies && !systemEntitled;
    const platformDefault = vetoed.size > 0 || entitlementSuppressed ? { entitlementSuppressed, vetoed: [...vetoed] } : undefined;
    return { tenantRows, systemRows, vetoed, platformDefault, systemEntitled };
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
   *
   * PUBLIC since TASK-862 for `ProviderCredentialResolver` — the SAME
   * construction site serves the fold and the one-credential resolver, so
   * funding derivation cannot fork. Gateway-side only: the result is plaintext.
   */
  async toOverrideEntry(row: AiProviderConnectionEntity, service: ProviderService): Promise<ProviderOverrideEntry | null> {
    if (!this.secretsService || !row.encryptedApiKey) return null;
    try {
      const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
      // C.2 — VALIDATED PASSTHROUGH, not an allow-list.
      //
      // This used to forward exactly four keys (`model`/`foundryModel`,
      // `project`, `location`) while `extraJson` accepted anything, so every
      // other per-endpoint quirk was stored and then silently DROPPED in
      // transit. `sanitizeProviderExtras` instead checks the SHAPE (flat, safe
      // keys, scalar or scalar-array values, bounded) and forwards whatever
      // passes, so a new provider capability flag needs a console write and no
      // code change here.
      //
      // ORDER MATTERS and is the security property: the extras are folded FIRST
      // and the column-backed fields are written OVER them. The reserved-key
      // rule in `provider-extras.ts` already refuses `api_key`, `funding`,
      // `base_url`, `region`, `api_version` and `deployment_name`, so this is
      // belt-and-braces — a row can never restate the credential, redirect the
      // endpoint, or stamp the DERIVED funding label.
      const extras = sanitizeProviderExtras(row.extraJson);

      // `foundryModel` is the pre-unification spelling of `model` on STT rows.
      // De-alias it (never overriding an explicit `model`) and drop the old
      // spelling rather than putting both on the wire — this is what lets a
      // SYSTEM-sourced STT entry keep its model id, since the caller-side
      // `list()` fold that used to supply it is tenant-pinned and cannot see
      // the platform row.
      if (typeof extras.foundryModel === 'string' && extras.model === undefined) {
        extras.model = extras.foundryModel;
      }
      delete extras.foundryModel;

      const entry: ProviderOverrideEntry = { ...extras, api_key: apiKey, funding: this.fundingOf(row) };
      if (row.baseUrl) entry.base_url = row.baseUrl;
      if (row.region) entry.region = row.region;
      if (row.apiVersion) entry.api_version = row.apiVersion;
      if (row.deploymentName) entry.deployment_name = row.deploymentName;
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

  /**
   * resolve ONE credential for a consumer that cannot reach the DB.
   *
   * The `/internal/*` projection of the cascade. See
   * `IProviderConnectionService#resolveCredential` for the four-outcome contract
   * and why `absent` and `unavailable` must stay distinct.
   *
   * The cascade is NOT reimplemented here: `resolveTenantCloudOverrides` is the
   * one place tenant-vs-SYSTEM precedence, the veto set, the entitlement gate
   * and derived funding live. This maps its result and nothing more — which is
   * also why `funding` is read off the entry rather than computed a second time.
   */
  async resolveCredential(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderCredential> {
    this.assertResolvable(service, provider, tenantId);

    let resolved: ResolvedProviderOverrides;
    try {
      resolved = await this.resolveTenantCloudOverrides(service, tenantId);
    } catch (error) {
      // Deliberately does NOT interpolate the error body — a Vault-Transit or
      // driver error string can echo the payload it choked on. Same rule as
      // `toOverrideEntry`'s decrypt-failure log.
      this.logger.error(`Credential resolve failed for ${service}/${provider} (tenant ${tenantId})`);
      void error;
      return { outcome: 'unavailable', reason: 'credential resolution failed' };
    }

    const entry = resolved.overrides[provider];
    if (entry) {
      // Split the wire entry back into "the row's own fields" and "everything
      // else". `provider-extras.ts` already refuses the reserved keys on write,
      // so destructuring them out here is the belt-and-braces half of that same
      // rule: `extras` may carry the NON-SECRET half of a two-part credential
      // (`accessKeyId`) and can never carry the secret half or a stamped
      // `funding` label.
      const { api_key: apiKey, funding, base_url: baseUrl, region, api_version: apiVersion, deployment_name: deploymentName, ...extras } = entry;
      return {
        outcome: 'resolved',
        apiKey,
        funding,
        ...(baseUrl ? { baseUrl } : {}),
        ...(region ? { region } : {}),
        ...(apiVersion ? { apiVersion } : {}),
        ...(deploymentName ? { deploymentName } : {}),
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      };
    }

    const outcome = resolved.platformDefault;
    if (outcome?.vetoed.includes(provider)) {
      return { outcome: 'denied', reason: `tenant veto: '${provider}' is disabled for service '${service}'` };
    }
    // The entitlement gate governs platform SPEND on a VENDOR account, so it
    // denies only a CLOUD provider. A SYSTEM row for platform infrastructure
    // stays reachable — the same `isCloudByoProvider` split the cascade itself
    // applies, read here rather than re-derived.
    if (outcome?.entitlementSuppressed && isCloudByoProvider(service, provider)) {
      return { outcome: 'denied', reason: 'the platform-default credential entitlement is not granted for this tenant' };
    }

    return { outcome: 'absent' };
  }

  /**
   * The three input checks every one-credential resolve shares (TASK-862 —
   * also used by `ProviderCredentialResolver`).
   *
   * No tenant-less form, deliberately: it could only mean "read SYSTEM
   * unconditionally", which is the widen-without-absence bug the two-tier rule
   * exists to prevent. A caller with no tenant of its own passes SYSTEM.
   */
  assertResolvable(service: ProviderService, provider: string, tenantId: string): void {
    if (!PROVIDER_SERVICES.includes(service)) {
      throw new BadRequestException(`Unknown provider service '${service}'. Expected one of: ${PROVIDER_SERVICES.join(', ')}.`);
    }
    if (!provider?.trim()) {
      throw new BadRequestException('provider is required');
    }
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId is required');
    }
  }

  /**
   * refuse a connection that cannot serve a request, at SAVE time.
   *
   * `provider-requirements.ts` holds the declarations and the reasoning; this is
   * only the throw. `ArgumentInvalidException` (→ 400) rather than a Forbidden
   * or a Conflict: the caller is permitted to write this row, and no version
   * raced them — the BODY is incomplete, and the message names exactly which
   * field to add. Every miss is reported at once so an operator fixes the form
   * in one round trip.
   *
   * DISABLED rows are exempt inside the predicate, not here — see that file for
   * why the veto has to stay expressible.
   */
  private assertRequirementsSatisfied(service: ProviderService, provider: string, subject: ConnectionRequirementSubject): void {
    const errors = validateProviderRequirements(service, provider, subject);
    if (errors.length > 0) {
      throw new ArgumentInvalidException(errors.join(' '));
    }
  }

  /** Funding is a pure function of WHOSE row supplied the credential. */
  private fundingOf(row: AiProviderConnectionEntity): ProviderFunding {
    return row.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant';
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The declared-model rows of ONE connection (TASK-890 §3.7a).
   *
   * Empty — never an error — when the registry repository was not wired or the
   * row is the SYSTEM tier: a platform connection declares no per-tenant models
   * by construction, so "none" is the truth rather than a missing answer.
   */
  private async declaredModels(
    connection: AiProviderConnectionEntity,
    tenantId: string,
    tx?: CoreDatabaseService['baseClient'],
  ): Promise<AiModelEntity[]> {
    if (!this.aiModelRepository || tenantId === SYSTEM_TENANT_ID) return [];
    return this.aiModelRepository.findBySourceConnection(connection.id, tenantId, tx).catch(() => []);
  }

  /** Soft-delete every model declared on a connection that is going away. */
  private async softDeleteDeclaredModels(
    connection: AiProviderConnectionEntity,
    tenantId: string,
    tx?: CoreDatabaseService['baseClient'],
  ): Promise<void> {
    const rows = await this.declaredModels(connection, tenantId, tx);
    for (const row of rows) {
      await this.aiModelRepository!.softDelete(row.id, this.requestUserId ?? undefined, tx);
    }
  }

  /**
   * Validate the WHOLE declaration up front and compute each entry's slug.
   *
   * Every refusal here is a 400 naming the offending entry, and it happens
   * before the first write — property (2) of `declareModels`.
   */
  private validateDeclaration(
    service: ByoDeclarableService | ProviderService,
    provider: string,
    dto: DeclareConnectionModelsRequest,
  ): Array<{ slug: string; suggestedSlug: string; declaration: ByoModelDeclaration }> {
    const entries = dto.models ?? [];
    const seenWireIds = new Set<string>();
    const seenSlugs = new Set<string>();
    return entries.map((entry) => {
      const wireModelId = entry.wireModelId?.trim() ?? '';
      if (!wireModelId) throw new BadRequestException('Every declared model needs a wireModelId.');
      if (seenWireIds.has(wireModelId)) {
        throw new BadRequestException(`Model id '${wireModelId}' is declared twice; each model may appear once.`);
      }
      seenWireIds.add(wireModelId);
      if (!isTaskTypeOfService(service as ProviderService, entry.taskType)) {
        throw new BadRequestException(
          `Task type '${entry.taskType}' is not served by the '${service}' capability. Expected one of: ` +
            `${taskTypesOfService(service as ProviderService).join(', ')}.`,
        );
      }
      // The slug is server-generated; an explicit one is accepted ONLY as the
      // `byo-` suggestion a shadow conflict offered, so a tenant cannot invent a
      // name that shadows a platform row through the front door either.
      const generated = byoModelSlug(provider, wireModelId);
      const suggestedSlug = suggestedByoModelSlug(provider, wireModelId);
      const slug = entry.slug?.trim() ? entry.slug.trim() : generated;
      if (slug !== generated && slug !== suggestedSlug) {
        throw new BadRequestException(
          `Slug '${slug}' is not a name this platform generates for '${wireModelId}'. Omit it, or send '${suggestedSlug}'.`,
        );
      }
      if (seenSlugs.has(slug)) throw new BadRequestException(`Two declared models resolve to the same name '${slug}'.`);
      seenSlugs.add(slug);
      return {
        slug,
        suggestedSlug,
        declaration: {
          wireModelId,
          name: entry.name.trim(),
          taskType: entry.taskType,
          ...(entry.capabilities ? { capabilities: { ...entry.capabilities } } : {}),
        },
      };
    });
  }

  /**
   * Keep the SINGLE-MODEL extra in step with the declaration (TASK-890 §3.7a).
   *
   * Before this ticket a speech connection named its one model in
   * `extraJson.model`, and that extra is forwarded on the wire
   * (`toOverrideEntry`) where it PINS the model for every call. The models
   * editor replaces that field for the operator, so the pin has to follow the
   * declaration or a single-model tenant silently changes behaviour — and a
   * STALE pin is worse: it makes every declared model but one unreachable,
   * which is the exact defect this ticket removes for Azure OpenAI.
   *
   * `llm` is deliberately excluded. Its equivalent field is the connection's
   * `deploymentName`, and pinning THAT is what the wire fix stopped doing; a
   * `model` extra there would reintroduce the same override one level up.
   */
  private async syncSingleModelExtra(
    connection: AiProviderConnectionEntity,
    service: ProviderService,
    declared: AiModelEntity[],
    tx?: CoreDatabaseService['baseClient'],
  ): Promise<void> {
    if (service === 'llm') return;
    const extras = { ...((connection.extraJson as Record<string, unknown> | null) ?? {}) };
    const pinned = declared.length === 1 ? (declared[0]!.wireModelId ?? declared[0]!.sourceUri) : null;
    const current = typeof extras.model === 'string' ? extras.model : null;
    if (current === pinned) return;

    if (pinned) extras.model = pinned;
    else delete extras.model;
    connection.extraJson = extras as AiProviderConnectionEntity['extraJson'];
    if (!connection.hasChanges) return;
    await this.connectionRepository.updateWithVersion(connection.id, connection, connection.version, tx);
  }

  /**
   * Fold a re-declared entry onto its existing row through the entity's
   * change-tracking setters. Returns whether anything actually changed, so an
   * unchanged re-declaration writes nothing and bumps no timestamp.
   *
   * The slug is NOT among the fields: it is the row's identity for every
   * binding that already resolved it.
   */
  private applyDeclaration(row: AiModelEntity, declaration: ByoModelDeclaration, userId?: string): boolean {
    if (row.name !== declaration.name) row.name = declaration.name;
    if (row.wireModelId !== declaration.wireModelId) row.wireModelId = declaration.wireModelId;
    if (row.sourceUri !== declaration.wireModelId) row.sourceUri = declaration.wireModelId;
    if (row.taskType !== declaration.taskType) row.taskType = declaration.taskType;
    const nextMeta = declaration.capabilities ? { capabilities: { ...declaration.capabilities } } : {};
    if (JSON.stringify((row.metaData as unknown) ?? {}) !== JSON.stringify(nextMeta)) {
      row.metaData = nextMeta as AiModelEntity['metaData'];
    }
    if (!row.hasChanges) return false;
    if (userId) row.updatedBy = userId;
    return true;
  }

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
      timeoutS: entity.timeoutS ?? null,
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
