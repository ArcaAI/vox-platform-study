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
  TenantStorageConfigRepository,
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
  ResolveConnectionOptions,
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
import {
  CLOUD_BYO_PROVIDERS,
  CONNECTION_ERROR_CODES,
  MAX_AI_PROVIDER_CONNECTIONS_KEY,
  PROVIDER_SERVICES,
  ProviderService,
  isCloudByoProvider,
  isKnownProviderId,
} from './constants';
import { builtInDefaultFor } from './built-in-defaults';
import { PLATFORM_STORAGE_CREDENTIAL_SOURCE, resolvePlatformStorageCredential } from './platform-storage-credential';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import {
  AiProviderConnectionResponse,
  DeclareConnectionModelsRequest,
  PlatformDefaultConnectionResponse,
  PlatformDefaultConnectionsResponse,
  PlatformDefaultResolution,
  UpsertAiProviderConnectionRequest,
} from './dto';
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
/** Per-write knobs shared by the create and revive paths. */
interface WriteOptions {
  /**
   * Whether `provider-requirements.ts` judges this write. Default `true`.
   *
   * `false` is used by ONE caller — `resetRow` — and the reason is narrow: the
   * body it writes is not an operator's, it is `BUILT_IN_CONNECTION_DEFAULTS`,
   * which is pinned by a contract test to be EXACTLY what the seed writes on a
   * fresh database. `llm:llama-cpp` is the case that forces the point: the seed
   * ships it enabled without `extraJson.modelPath` (the seed runs no
   * requirement check), so a reset that ran the check would refuse to restore
   * precisely the row whose default the platform itself ships. The requirement
   * table still governs every operator write, including the next edit of the
   * row this just restored.
   */
  enforceRequirements?: boolean;

  /**
   * TASK-958 — is the written row its provider's DEFAULT (`defaultForProvider =
   * provider`) or a named sibling (`null`)?
   *
   * ABSENT means DEFAULT, deliberately: that is the factory's own default, it is
   * what every platform row is, and it is what `resetRow` restores. Only
   * `upsertRow` — the one path that can create a sibling — passes it explicitly.
   */
  markDefault?: boolean;
}

/** The one sanctioned `enforceRequirements: false` — see `WriteOptions`. */
const RESTORE_BUILT_IN: WriteOptions = { enforceRequirements: false };

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
    // TASK-932 D-7 — the platform's OWN object storage, which is what an
    // enabled-and-keyless `model-registry:s3` row resolves to. Both are
    // `@Optional()` and TRAILING so every existing positional fixture keeps its
    // arity; ABSENT means the fallback simply does not apply (`absent`, the
    // pre-ticket behaviour), never a substituted empty credential.
    @Optional() private readonly storageConfigRepository?: TenantStorageConfigRepository,
    @Optional() @Inject(IAppSettingsService) private readonly appSettingsService?: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.AiProviderConnection);
  }

  async list(service: ProviderService, tenantId?: string): Promise<AiProviderConnectionResponse[]> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const rows = await this.connectionRepository.findByTenantIdAndService(service, scopedTenantId, tx);
    return rows.filter((r) => this.isVisibleToTier(service, r.provider, scopedTenantId)).map((r) => AiProviderConnectionDtoMapper.toResponse(r));
  }

  async getRow(service: ProviderService, slug: string, tenantId?: string): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const row = await this.connectionRepository.findByTenantServiceSlug(service, slug, scopedTenantId, tx);
    // TASK-958 — the tier boundary is drawn on the row's PROVIDER, which for an
    // existing row is the row's own and for a miss can only be read off the slug
    // (a placeholder is only ever offered for the provider-named default).
    this.assertVisibleToTier(service, row?.provider ?? slug, scopedTenantId);
    if (!row) return { ...AiProviderConnectionDtoMapper.placeholder(service, scopedTenantId, slug), models: [] };
    // TASK-890 §3.7a — the single-row read carries the models declared on it, so
    // the console edits credential and model list from ONE payload.
    return AiProviderConnectionDtoMapper.toResponse(row, await this.declaredModels(row, scopedTenantId, tx));
  }

  /**
   * TASK-954 — the platform fallback a TENANT inherits, projected READ-ONLY.
   *
   * WHY THIS EXISTS. A tenant admin may not address the SYSTEM tier
   * (`?tenantId=SYSTEM` is a 403) and `list()` under a tenant scope returns
   * the tenant's OWN rows only (R-12), so until now the console could not say
   * whether "use platform default" on a tenant card would actually serve
   * anything. The owner's rule is that a tenant admin sees and configures its
   * own providers AND sees the platform fallback read-only — this is that read.
   *
   * WHY IT IS BUILT ON `cascadeRows`. The veto set and the entitlement gate are
   * the two facts that decide whether the SYSTEM tier serves a tenant, and
   * both live in exactly one place. Re-deriving them here would be a second
   * `if` that could disagree with the fold; reading them from the cascade means
   * a tenant is never told it inherits a credential a real request would refuse.
   *
   * WHAT A TENANT LEARNS. One MASKED entry per cloud BYO provider of the service
   * — `hasKey`, never the key — plus a `resolution` per entry. Platform-managed
   * engines and the model registry are platform infrastructure and are never
   * listed (the same boundary `isVisibleToTier` draws on the direct read).
   * Nothing is decrypted: this is a projection of row STATE, not of credentials.
   */
  async listPlatformDefaults(service: ProviderService, tenantId?: string): Promise<PlatformDefaultConnectionsResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    if (scopedTenantId === SYSTEM_TENANT_ID) {
      throw new BadRequestException(
        'The platform (SYSTEM) tier is the top of the cascade and inherits no platform default. ' +
          'Read its own rows with `GET admin/providers/:service` instead.',
      );
    }

    const { tenantRows, systemRows, vetoed, systemEntitled } = await this.cascadeRows(service, scopedTenantId);

    const connections: PlatformDefaultConnectionResponse[] = CLOUD_BYO_PROVIDERS[service].map((provider) => {
      const systemRow = systemRows.find((row) => row.provider === provider);
      // TASK-958 — the tenant may hold several rows for this provider; the one
      // that decides whether the platform default is reached is the DEFAULT.
      const tenantRow = tenantRows.find((row) => row.provider === provider && row.isDefault);
      const projected = systemRow
        ? AiProviderConnectionDtoMapper.toResponse(systemRow)
        : AiProviderConnectionDtoMapper.placeholder(service, SYSTEM_TENANT_ID, provider);
      return {
        ...projected,
        resolution: AiProviderConnectionService.platformDefaultResolution({
          tenantRow,
          systemRow,
          vetoed: vetoed.has(provider),
          entitled: systemEntitled,
        }),
      };
    });

    return { service, tenantId: scopedTenantId, entitled: systemEntitled, connections };
  }

  /**
   * The cascade's verdict for one platform cloud row, in the order the cascade
   * itself decides: the tenant's own facts (override, veto) first, then the
   * entitlement, then the platform row's own state.
   */
  private static platformDefaultResolution(facts: {
    tenantRow: AiProviderConnectionEntity | undefined;
    systemRow: AiProviderConnectionEntity | undefined;
    vetoed: boolean;
    entitled: boolean;
  }): PlatformDefaultResolution {
    const { tenantRow, systemRow, vetoed, entitled } = facts;
    if (tenantRow?.enabled && tenantRow.hasKey) return 'overridden';
    if (vetoed) return 'vetoed';
    if (!entitled) return 'not-entitled';
    if (!systemRow || !systemRow.hasKey) return 'not-configured';
    if (!systemRow.enabled) return 'off';
    return 'inherited';
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
    slug: string,
    dto: DeclareConnectionModelsRequest,
    tenantId?: string,
  ): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    if (scopedTenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('Platform models are declared in /admin/ai-models; a SYSTEM connection declares none.');
    }
    if (!isByoDeclarableService(service)) {
      throw new BadRequestException(
        `The '${service}' capability serves no per-tenant model rows. Declarable services: ${BYO_DECLARABLE_SERVICES.join(', ')}.`,
      );
    }
    if (!this.aiModelRepository) {
      throw new ServiceUnavailableException('The model registry is unavailable; models cannot be declared right now.');
    }

    const tx = this.crossTenantLane(scopedTenantId);
    const connection = await this.connectionRepository.findByTenantServiceSlug(service, slug, scopedTenantId, tx);
    if (!connection) {
      throw new NotFoundException(`No connection row named '${slug}' (service '${service}'). Save the connection before declaring its models.`);
    }
    const provider = connection.provider;
    // The SAME class gate as every other write on this row: a provider the
    // tenant may not hold a connection for cannot be given models either. It
    // runs on the ROW's provider, after the row is resolved — the slug alone no
    // longer names a vendor.
    this.assertWriteAllowed(service, provider, scopedTenantId);

    // TASK-958 — the generated model slug is named after the CONNECTION, not the
    // provider, so two accounts of one vendor may declare the same wire id.
    const entries = this.validateDeclaration(service, connection.slug, dto);

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

      // TASK-958 — and it may not take a name ANOTHER connection of this tenant
      // already minted. `AiModel` uniqueness is `(tenantId, slug)`, so without
      // this the second connection's declaration answers a raw `P2002` with no
      // name and no remedy. Named here, up front, for the same reason as the
      // shadow check: nothing is written until every entry validates.
      const taken = await this.aiModelRepository.findBySlug(scopedTenantId, entry.slug, tx ?? this.databaseService.baseClient);
      if (taken && taken.sourceConnectionId && taken.sourceConnectionId !== connection.id) {
        const siblings = await this.connectionRepository.findByTenantIdAndService(service, scopedTenantId, tx);
        const owner = siblings.find((row) => row.id === taken.sourceConnectionId);
        throw new ConflictException({
          code: CONNECTION_ERROR_CODES.BYO_SLUG_TAKEN,
          message:
            `This tenant already has a model named '${entry.slug}' declared on connection ` +
            `'${owner?.slug ?? taken.sourceConnectionId}'. Withdraw it there, or re-send this entry with slug ` +
            `'${entry.suggestedSlug}'.`,
          slug: entry.slug,
          otherConnectionSlug: owner?.slug ?? null,
          otherConnectionId: taken.sourceConnectionId,
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
    slug: string,
    dto: UpsertAiProviderConnectionRequest,
    tenantId?: string,
    expectedVersion?: number,
  ): Promise<AiProviderConnectionResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    // TASK-958 — the slug is a URL segment, the prefix of every model slug this
    // connection mints and the `connection_slug` on the wire. Shape first: a
    // malformed one has no valid interpretation to argue about.
    this.assertSlugShape(slug);

    // C2 supplies `expectedVersion` as an explicit param; the pre-unification
    // convention carried it inside the DTO. Prefer the explicit param, fall back
    // to the DTO — so the gateway may pass it either way during the transition.
    const ev = expectedVersion ?? dto.expectedVersion;

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantServiceSlug(service, slug, scopedTenantId, tx);

    // WHICH VENDOR. On an update the row already answered it and the answer is
    // immutable; on a create the body says so, or the slug does when it is
    // itself a provider id — which is every call that predates this ticket.
    const provider = this.resolveProviderForWrite(service, slug, dto, existing, scopedTenantId);
    this.assertWriteAllowed(service, provider, scopedTenantId);
    // The platform tier has no notion of a named or non-default connection at
    // all, so it is answered BEFORE the default is reasoned about — otherwise a
    // platform `isDefault: false` would get the tenant-tier advice ("elect
    // another row") for a tier that has no other row to elect.
    this.assertPlatformTierShape(slug, provider, dto, scopedTenantId);

    // Is this row its provider's DEFAULT once the write lands? Every
    // multiplicity rule below is a statement about that answer.
    const currentDefault = await this.connectionRepository.findDefaultByTenantServiceProvider(service, provider, scopedTenantId, tx);
    const willBeDefault = this.resolveDefaultIntent(dto, existing, currentDefault);
    this.assertMultiplicityAllowed(service, slug, provider, scopedTenantId, willBeDefault);

    if (!existing) {
      if (ev !== undefined && ev !== 0) {
        throw new OptimisticConcurrencyException('AiProviderConnection', `${scopedTenantId}:${service}:${slug}`, {
          expectedVersion: ev,
          currentVersion: 0,
        });
      }

      // D-8 — the plan ceiling, on CREATE only and never on the platform tier
      // (the platform does not bound itself). Entitlements BOUND, they never
      // supply: `null` — every seeded plan today — is unbounded and the check
      // returns without reading anything else.
      await this.assertConnectionQuota(scopedTenantId, tx);

      // F-028 — restore-with-overwrite. The unique (tenantId, service, slug)
      // index counts soft-DELETED rows, so a plain INSERT after a delete
      // collides with the tombstone (409 unique-constraint) with no HTTP
      // recovery path. A create-intent (`If-Match: "0"`) over a DELETED row
      // instead REVIVES it — restore + apply every field as a fresh write.
      const deleted = await this.connectionRepository.findDeletedByTenantServiceSlug(service, slug, scopedTenantId, tx);
      if (deleted) {
        return this.withDefaultFlip(willBeDefault, currentDefault, deleted.id, tx, (lane) =>
          this.restoreAndOverwrite(deleted, dto, service, provider, scopedTenantId, lane, { markDefault: willBeDefault }),
        );
      }

      return this.withDefaultFlip(willBeDefault, currentDefault, null, tx, (lane) =>
        this.createFromDto(dto, service, slug, provider, scopedTenantId, lane, { markDefault: willBeDefault }),
      );
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
    // TASK-958 — `name` is the one free-text field: renaming is what it is FOR
    // (the slug is immutable precisely so renaming stays free).
    if (dto.name !== undefined) changes.name = dto.name;
    // Electing this row as the default is a change to THIS row too; the previous
    // default is cleared beside it, in one transaction (below).
    if (willBeDefault && !existing.isDefault) changes.defaultForProvider = provider;
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
    const updated = await this.withDefaultFlip(willBeDefault, currentDefault, existing.id, tx, (lane) =>
      this.connectionRepository.updateWithVersion(existing.id, existing, ev, lane),
    );
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        service,
        provider,
        slug: updated.slug,
        tenantId: scopedTenantId,
        previousVersion,
        newVersion: updated.version,
        // Record THAT the key rotated, never the key itself.
        action: secret ? 'connection-key-rotated' : 'connection-updated',
      },
    });
    return AiProviderConnectionDtoMapper.toResponse(updated);
  }

  async deleteRow(service: ProviderService, slug: string, tenantId?: string, _expectedVersion?: number): Promise<void> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantServiceSlug(service, slug, scopedTenantId, tx);
    if (!existing) {
      // An absent row is a 404, matching the frozen contract and the
      // `TenantTtsConfigService.removeCredential` precedent. A cross-tenant row
      // reads as absent through the scope extension, so the same 404 hides
      // existence — the house posture, not a 400 "bad argument".
      throw new NotFoundException(`No connection row named '${slug}' (service '${service}').`);
    }
    const provider = existing.provider;
    this.assertWriteAllowed(service, provider, scopedTenantId);

    // OQ-6 — a DEFAULT with living siblings is REFUSED, never auto-promoted.
    // Promotion would silently change which vendor account every agent bound to
    // a SYSTEM catalogue model spends, on an operation nobody performed.
    if (existing.isDefault) {
      const group = await this.connectionRepository.findAllByTenantServiceProvider(service, provider, scopedTenantId, tx);
      const siblings = group.filter((row) => row.id !== existing.id);
      if (siblings.length > 0) {
        throw new ConflictException({
          code: CONNECTION_ERROR_CODES.IS_DEFAULT,
          message:
            `'${slug}' is the default connection for '${provider}' (service '${service}') and ${siblings.length} other ` +
            `connection(s) still use that provider. Make one of them the default first, then delete this one.`,
          slug,
          provider,
          siblingSlugs: siblings.map((row) => row.slug),
        });
      }
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
      data: { service, provider, slug, tenantId: scopedTenantId, action: 'connection-deleted' },
    });
  }

  /**
   * TASK-932 R-3/D-8 — restore ONE platform-managed row to its built-in default.
   *
   * The undo an admin actually needs, and the one `DELETE` cannot be. Deleting a
   * SYSTEM engine row does not "return it to the default": `apps/text` resolves a
   * self-hosted engine's base URL only from the injected `provider_overrides`
   * fold, with no env fallback, so a missing row is a 503 on every generate.
   * Reset therefore REWRITES the row from `BUILT_IN_CONNECTION_DEFAULTS`.
   *
   * AUTH-NOTE: SUPER_ADMIN-ONLY, enforced imperatively. The decorator on the
   * route reads `@CanManage('GlobalSetting')` because there is no "super admin"
   * CASL subject and tenant admins legitimately hold `manage` for every OTHER
   * operation on this controller; the real gate is the `isSuperAdmin` check
   * below (403 — a privilege rule, NOT the 404-over-403 cross-tenant posture).
   *
   * ORDER. The privilege check runs FIRST and is row-INDEPENDENT: every caller
   * who is not a platform administrator gets the same 403 for every provider,
   * existing or not, so there is no existence oracle to leak (the same shape as
   * `assertElevatedTenantlessContext` on the promotion routes). The
   * tier/existence answers that DO vary by argument come after it.
   *
   * WHAT IT RESTORES. Exactly what the default declares — endpoint, `enabled`,
   * `extraJson`, and the key material (the non-secret self-host placeholder for
   * an engine; nothing at all for the two model-registry rows, whose blank state
   * IS their default) — plus the three vendor columns cleared, since no built-in
   * provider addresses itself by region/api-version/deployment. The CEILINGS are
   * deliberately preserved: `maxConcurrent` and friends are an operator's tuning
   * of their own hardware, not part of the row's identity, and silently wiping
   * them would make "reset the endpoint" a lossy operation.
   */
  async resetRow(service: ProviderService, slug: string, tenantId?: string): Promise<AiProviderConnectionResponse> {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Built-in provider connections are reset by platform super administrators only.');
    }

    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    // TASK-958 — only the platform tier ships a built-in default, and there
    // `slug === provider` by construction (`PLATFORM_CONNECTION_PER_PROVIDER`),
    // so the segment is read as both. The tier check below is what makes that
    // true; a tenant slug never reaches the lookup with a different meaning.
    const provider = slug;
    const fallback = builtInDefaultFor(service, provider);
    if (!fallback) {
      throw new NotFoundException(
        `Provider '${provider}' (service '${service}') has no built-in default to reset to. ` +
          'Only the platform-managed inference engines and the model registry ship one.',
      );
    }
    if (scopedTenantId !== SYSTEM_TENANT_ID) {
      throw new ForbiddenException(
        `'${service}:${provider}' is platform-managed: its built-in default lives on the platform (SYSTEM) tier, ` +
          'so there is nothing to reset for an individual tenant.',
      );
    }

    const dto: UpsertAiProviderConnectionRequest = {
      baseUrl: fallback.baseUrl,
      region: null,
      apiVersion: null,
      deploymentName: null,
      enabled: fallback.enabled,
      extraJson: fallback.extraJson,
      ...(fallback.apiKey !== null ? { apiKey: fallback.apiKey } : {}),
    };

    const tx = this.crossTenantLane(scopedTenantId);
    const existing = await this.connectionRepository.findByTenantServiceSlug(service, slug, scopedTenantId, tx);

    if (!existing) {
      // A row an admin deleted is REVIVED rather than re-inserted: the unique
      // (tenantId, service, slug) index counts the tombstone, so a plain
      // create would 409 with no HTTP recovery path (F-028).
      const deleted = await this.connectionRepository.findDeletedByTenantServiceSlug(service, slug, scopedTenantId, tx);
      if (deleted) return this.restoreAndOverwrite(deleted, dto, service, provider, scopedTenantId, tx, RESTORE_BUILT_IN);
      return this.createFromDto(dto, service, slug, provider, scopedTenantId, tx, RESTORE_BUILT_IN);
    }

    // The key is written unconditionally when the default declares one (so a
    // rotated-then-broken engine row is repaired), and CLEARED when it does not
    // — a stored token on a model-registry row is precisely what "reset to the
    // built-in default" is asked to remove.
    const secret = fallback.apiKey !== null ? await this.encryptKey(fallback.apiKey) : undefined;
    const previousVersion = existing.version;
    await this.updateEntity(existing, {
      baseUrl: fallback.baseUrl,
      region: null,
      apiVersion: null,
      deploymentName: null,
      enabled: fallback.enabled,
      extraJson: fallback.extraJson,
      encryptedApiKey: secret?.ciphertext ?? null,
      keyVersion: secret?.keyVersion ?? null,
    });

    if (!existing.hasChanges) {
      // Already at the default. Idempotent by contract — no version bump, no
      // `updatedAt` rewrite, no event: a reset that changed nothing did nothing.
      return AiProviderConnectionDtoMapper.toResponse(existing);
    }

    const updated = await this.connectionRepository.updateWithVersion(existing.id, existing, previousVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        service,
        provider,
        tenantId: scopedTenantId,
        previousVersion,
        newVersion: updated.version,
        action: 'connection-reset-to-default',
      },
    });
    return AiProviderConnectionDtoMapper.toResponse(updated);
  }

  async resolveConnection(
    service: ProviderService,
    provider: string,
    tenantId: string,
    options?: ResolveConnectionOptions,
  ): Promise<ResolvedProviderConnection | null> {
    const { tenantRows, systemRows, vetoed } = await this.cascadeRows(service, tenantId, provider);

    // The veto fails CLOSED: never the platform default, never another
    // provider. (A vetoed row is disabled, so the tenant branch below could
    // not match anyway — this is explicit because the SYSTEM branch could.)
    //
    // TASK-958 — it is checked BEFORE the by-id branch on purpose: a tenant that
    // disabled its DEFAULT connection for a provider has blocked that provider,
    // and an enabled sibling does not reopen it (D-6). The veto is the coarsest
    // statement a tenant can make and it wins over every finer one.
    if (vetoed.has(provider)) return null;

    if (options?.connectionId) {
      const row = this.pickById([...tenantRows, ...systemRows], options.connectionId, service, provider, tenantId);
      if (!row.enabled) return null;
      return this.toResolved(row, row.tenantId === SYSTEM_TENANT_ID ? 'system' : 'tenant');
    }

    // A DISABLED row is treated as absent at both tiers — that is what makes
    // the shipped all-disabled seed behaviour-neutral (silent-change guard).
    // TASK-958 — "the tenant row" is the tenant's DEFAULT connection for this
    // provider; a named sibling is reachable only by id, never by provider name.
    const tenantRow = tenantRows.find((r) => r.isDefault && r.enabled);
    if (tenantRow) return this.toResolved(tenantRow, 'tenant');
    const systemRow = systemRows.find((r) => r.enabled);
    if (systemRow) return this.toResolved(systemRow, 'system');
    return null;
  }

  /**
   * ONE row out of the two tiers the cascade already read, by id (TASK-958 D-3).
   *
   * An id that is not in that set is a **404**, never a 403: the set is exactly
   * "the rows this tenant may see for this (service, provider)", so a miss means
   * either no such connection or another tenant's — and the house posture does
   * not distinguish them. Reading the row through the cascade rather than by a
   * direct id lookup is what makes the tenant boundary structural: there is no
   * query here that COULD return a foreign row.
   */
  private pickById(
    rows: AiProviderConnectionEntity[],
    connectionId: string,
    service: ProviderService,
    provider: string,
    tenantId: string,
  ): AiProviderConnectionEntity {
    const row = rows.find((r) => r.id === connectionId);
    if (!row) {
      this.logger.warn(`Connection '${connectionId}' is not a ${service}/${provider} connection visible to tenant ${tenantId}; failing closed`);
      throw new NotFoundException(`No connection row '${connectionId}' for provider '${provider}' (service '${service}').`);
    }
    return row;
  }

  async findRow(service: ProviderService, slug: string, tenantId: string): Promise<AiProviderConnectionEntity | null> {
    const tx = this.crossTenantLane(tenantId);
    return this.connectionRepository.findByTenantServiceSlug(service, slug, tenantId, tx);
  }

  /**
   * The tenant's DEFAULT connection for one (service, provider) — what every
   * pre-TASK-958 `findRow(service, provider, tenantId)` caller meant, and what a
   * consumer that resolves by provider NAME must ask for now that a provider
   * names a GROUP of connections rather than one.
   */
  async findDefaultRow(service: ProviderService, provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null> {
    const tx = this.crossTenantLane(tenantId);
    return this.connectionRepository.findDefaultByTenantServiceProvider(service, provider, tenantId, tx);
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

        // TASK-958 D-6 — the fold is keyed by PROVIDER NAME and a tenant may
        // now hold several rows under one, so exactly one of them may occupy
        // that key: the DEFAULT. Without this the loop's last row would win,
        // which is non-determinism dressed as a rule. A named sibling reaches
        // the wire only through a binding that names it by id.
        if (tier === 'tenant' && !row.isDefault) continue;

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
  /**
   * INSERT one connection row from a full write intent.
   *
   * Extracted from `upsertRow`'s create branch (TASK-932) so `resetRow` can
   * re-create a row that was deleted outright without restating the
   * requirement check, the encrypt-after-precondition ordering, the factory call
   * and the `ResourceCreated` broadcast — four things that must stay identical
   * however the row comes into existence.
   */
  private async createFromDto(
    dto: UpsertAiProviderConnectionRequest,
    service: ProviderService,
    slug: string,
    provider: string,
    scopedTenantId: string,
    tx?: CoreDatabaseService['baseClient'],
    options: WriteOptions = {},
  ): Promise<AiProviderConnectionResponse> {
    // Requirements BEFORE encryption, for the same reason the precondition
    // check comes before it: a row that will be refused must not spend a
    // Vault round trip, and a Transit outage must not turn a 400 into a 500.
    if (options.enforceRequirements !== false) {
      this.assertRequirementsSatisfied(service, provider, {
        enabled: dto.enabled ?? false,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        apiVersion: dto.apiVersion ?? null,
        deploymentName: dto.deploymentName ?? null,
        hasApiKey: dto.apiKey !== undefined,
        extraJson: dto.extraJson ?? null,
      });
    }

    // Encrypt only when the caller actually supplied a key — and only AFTER
    // the precondition verdict above (encrypting first would turn a
    // stale-If-Match 412 into a 500 whenever Transit was down).
    const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;
    const entity = AiProviderConnectionFactory.CreateAiProviderConnection({
      tenantId: scopedTenantId,
      service,
      provider,
      slug,
      name: dto.name ?? null,
      // TASK-958 — the FIRST connection of a provider is its default; an
      // explicit `isDefault: true` on a later one flips it (the previous default
      // is cleared in the same transaction, see `withDefaultFlip`).
      defaultForProvider: (options.markDefault ?? true) ? provider : null,
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
      data: {
        service,
        provider,
        slug: saved.slug,
        isDefault: saved.isDefault,
        tenantId: scopedTenantId,
        enabled: saved.enabled,
        action: 'connection-created',
      },
    });
    return AiProviderConnectionDtoMapper.toResponse(saved);
  }

  private async restoreAndOverwrite(
    deleted: AiProviderConnectionEntity,
    dto: UpsertAiProviderConnectionRequest,
    service: ProviderService,
    provider: string,
    scopedTenantId: string,
    tx?: CoreDatabaseService['baseClient'],
    options: WriteOptions = {},
  ): Promise<AiProviderConnectionResponse> {
    const currentVersion = deleted.version;

    // A revive is a FRESH write — every field below is set from the DTO with no
    // carry-over from the tombstone — so it is judged exactly like a create.
    if (options.enforceRequirements !== false) {
      this.assertRequirementsSatisfied(service, provider, {
        enabled: dto.enabled ?? false,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        apiVersion: dto.apiVersion ?? null,
        deploymentName: dto.deploymentName ?? null,
        hasApiKey: dto.apiKey !== undefined,
        extraJson: dto.extraJson ?? null,
      });
    }

    const secret = dto.apiKey !== undefined ? await this.encryptKey(dto.apiKey) : undefined;

    deleted.enable(this.requestUserId ?? undefined);
    await this.updateEntity(deleted, {
      // TASK-958 — a revive is a fresh write, so the tombstone's OWN default
      // marker is not carried over: whether the revived row is the default is
      // decided by the same rule a create obeys (and by then the caller has
      // already flipped the previous default, if it is electing this one).
      name: dto.name ?? null,
      defaultForProvider: (options.markDefault ?? true) ? provider : null,
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
      data: {
        service,
        provider,
        slug: restored.slug,
        isDefault: restored.isDefault,
        tenantId: scopedTenantId,
        enabled: restored.enabled,
        action: 'connection-restored',
      },
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
    //
    // TASK-958 D-6 — read on the DEFAULT row only. A tenant's named siblings are
    // bindings, not policy: disabling one disables the models bound to THAT
    // connection (their candidate fails closed and the chain walks on) and says
    // nothing about the provider. The veto is the default row's to cast, and
    // conversely an enabled sibling does not reopen a provider the default
    // vetoed.
    const vetoed = new Set(tenantRows.filter((r) => r.isDefault && !r.enabled && isCloudByoProvider(service, r.provider)).map((r) => r.provider));

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
    // TASK-958 — EVERY row of the group, default first. The by-provider shape
    // used to read one row because one was all there could be; now the group is
    // what the cascade has to reason about (which one is the default, and can a
    // binding name a sibling by id), so it reads the group.
    return this.connectionRepository.findAllByTenantServiceProvider(service, provider, tenantId, tx);
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

      // TASK-958 — the connection identity travels with the credential, written
      // AFTER the extras spread so a row can never restate it. Two accounts of
      // one vendor are otherwise indistinguishable downstream: the ledger, a
      // request trace and an operator all see only `provider`.
      const entry: ProviderOverrideEntry = {
        ...extras,
        api_key: apiKey,
        funding: this.fundingOf(row),
        connection_id: row.id,
        connection_slug: row.slug,
      };
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
      const {
        api_key: apiKey,
        funding,
        base_url: baseUrl,
        region,
        api_version: apiVersion,
        deployment_name: deploymentName,
        // TASK-958 — identity, not a provider extra. Stripped here so an
        // `/internal/*` consumer that forwards `extras` verbatim to an adapter
        // never hands it two keys the vendor has never heard of.
        connection_id: _connectionId,
        connection_slug: _connectionSlug,
        ...extras
      } = entry;
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

    // TASK-932 D-7 — the weight store's BUILT-IN default. An ENABLED
    // `model-registry:s3` row that carries no credential of its own is not "no
    // opinion": it is the declaration that this platform's own object storage
    // holds the weights. Reached only HERE, after the veto and the entitlement
    // gate, so a tenant that vetoed the plane still gets `denied` and never a
    // silently-substituted platform credential.
    const platformStorage = await this.platformStorageFallback(service, provider, tenantId);
    if (platformStorage) return platformStorage;

    return { outcome: 'absent' };
  }

  /**
   * The `model-registry:s3` platform-storage branch, or `null` when it does not
   * apply (TASK-932 D-7).
   *
   * THREE conditions, all necessary. The REQUEST must be the platform's own —
   * D-7 declares exactly one lane, `resolveCredential('model-registry','s3',
   * SYSTEM)`, and the row this reads is the SYSTEM one whoever asked, so
   * without a tenant condition every customer tenant would inherit the
   * platform's own object-storage secret (returned as a real credential and
   * metered `funding: 'platform'`, which is also how it would be paid for).
   * A tenant that wants the weight store brings its own `model-registry:s3`
   * row, which the fold above has already returned before reaching here.
   *
   * Then the row must be the SYSTEM one and ENABLED —
   * a disabled row is the platform's own veto and must stay a non-answer — and
   * it must carry no credential of its own, because an explicit key on the row
   * is an operator's deliberate override of the built-in default and wins
   * outright (it has already been returned by the fold above, so reaching here
   * at all means there was none).
   *
   * A resolution FAULT is not swallowed: it propagates to `resolveCredential`'s
   * catch, which reports `unavailable`. Reading a Vault outage as "no credential
   * configured" would downgrade an entitled fetch to an anonymous one — the
   * exact confusion the four-outcome contract exists to prevent.
   */
  private async platformStorageFallback(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderCredential | null> {
    if (tenantId !== SYSTEM_TENANT_ID) return null;
    if (service !== 'model-registry' || provider !== 's3') return null;

    const systemRows = await this.readTier(service, SYSTEM_TENANT_ID, provider);
    const row = systemRows[0];
    if (!row || !row.enabled) return null;
    if ((row.encryptedApiKey?.length ?? 0) > 0) return null;

    const credential = await resolvePlatformStorageCredential({
      storageConfigRepository: this.storageConfigRepository,
      appSettings: this.appSettingsService,
      secrets: this.secretsService,
    });
    if (!credential) return null;

    this.logger.log(`model-registry:s3 resolved from the platform storage configuration for tenant ${tenantId}`);
    return {
      outcome: 'resolved',
      apiKey: credential.secretAccessKey,
      baseUrl: credential.endpoint,
      region: credential.region,
      // The platform paid for this store, whoever's model is being fetched.
      funding: 'platform',
      // `accessKeyId` is the non-secret half of the pair, in the same place an
      // explicitly-configured row would carry it, so the consumer
      // (`apps/stt`'s `model_credentials.py`) needs no new branch at all.
      extras: { accessKeyId: credential.accessKeyId },
      // ADDITIVE and optional — an unknown field the Python parser simply does
      // not read — saying WHICH tier answered, for an operator reading the
      // response or a future consumer that wants to distinguish the two.
      source: PLATFORM_STORAGE_CREDENTIAL_SOURCE,
    };
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
    connectionSlug: string,
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
      const generated = byoModelSlug(connectionSlug, wireModelId);
      const suggestedSlug = suggestedByoModelSlug(connectionSlug, wireModelId);
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
  /**
   * TASK-932 R-12 — whether a TIER may see `(service, provider)` at all.
   *
   * The platform tier sees everything it owns. A CUSTOMER tenant sees only the
   * cloud providers it may bring an account for: the built-in engines, the
   * platform's own self-hosted serving engines and the whole model-registry
   * plane are platform infrastructure (owner rule 2026-08-24, re-stated
   * 2026-09-09), and a tenant that can neither read nor write them has no reason
   * to be told they exist.
   *
   * This is the READ half of the boundary `assertWriteAllowed` already enforced
   * on writes. It is deliberately the OTHER posture — 404, not 403 — because the
   * two answer different questions: a write is "you may not do this to your own
   * tenant" (a privilege statement, nothing to hide), a read is "your tenant has
   * no such row" (existence, which the house posture hides).
   */
  private isVisibleToTier(service: ProviderService, provider: string, targetTenantId: string): boolean {
    if (targetTenantId === SYSTEM_TENANT_ID) return true;
    return isCloudByoProvider(service, provider);
  }

  private assertVisibleToTier(service: ProviderService, provider: string, targetTenantId: string): void {
    if (this.isVisibleToTier(service, provider, targetTenantId)) return;
    throw new NotFoundException(`No connection row for provider '${provider}' (service '${service}').`);
  }

  // ────────────────── TASK-958: identity, multiplicity, the default ──────────────────

  /**
   * The slug is a URL path segment, the prefix of every model slug this
   * connection mints and the `connection_key` on the Python wire. The entity
   * validates the same pattern; this refusal exists so the caller gets a NAMED
   * 400 with the rule in it rather than a `BusinessException` from persistence.
   */
  private assertSlugShape(slug: string): void {
    if (!AiProviderConnectionEntity.SLUG_PATTERN.test(slug ?? '')) {
      throw new BadRequestException({
        code: CONNECTION_ERROR_CODES.SLUG_INVALID,
        message:
          `'${slug}' is not a valid connection name. Use 2-63 characters: lowercase letters, digits and hyphens, ` +
          'starting with a letter or digit (for example `openai-research`).',
        slug,
      });
    }
  }

  /**
   * WHICH VENDOR this write is about.
   *
   * Three cases, in the order they are decided:
   *   1. the row EXISTS — its provider is the answer and it is IMMUTABLE. A
   *      connection that changed vendor under the models declared on it would
   *      re-point every binding without touching one of them (409);
   *   2. the body NAMES one — a named sibling (`openai-research`) must, because
   *      nothing else in the request says which vendor it is;
   *   3. the slug IS a provider id — every call that predates TASK-958, which is
   *      exactly why they are unchanged. On the SYSTEM tier this is always the
   *      case by rule (one row per provider, `slug === provider`).
   *
   * Anything else is a 400 that says what to send: a slug that is not a provider
   * id and no `provider` is not a typo the server should guess at.
   */
  private resolveProviderForWrite(
    service: ProviderService,
    slug: string,
    dto: UpsertAiProviderConnectionRequest,
    existing: AiProviderConnectionEntity | null,
    scopedTenantId: string,
  ): string {
    if (existing) {
      if (dto.provider !== undefined && dto.provider !== existing.provider) {
        throw new ConflictException({
          code: CONNECTION_ERROR_CODES.PROVIDER_IMMUTABLE,
          message:
            `Connection '${slug}' serves '${existing.provider}' and a connection cannot change vendor — the models ` +
            `declared on it name it. Create a new connection for '${dto.provider}' instead.`,
          slug,
          provider: existing.provider,
          requestedProvider: dto.provider,
        });
      }
      return existing.provider;
    }

    if (dto.provider !== undefined) return dto.provider;
    if (scopedTenantId === SYSTEM_TENANT_ID || isKnownProviderId(slug)) return slug;

    throw new BadRequestException({
      code: CONNECTION_ERROR_CODES.PROVIDER_REQUIRED,
      message:
        `'${slug}' is a connection name, not a provider, so the request must say which vendor it talks to: send ` +
        `\`provider\` (for example \`{"provider": "openai"}\`) alongside it.`,
      slug,
      service,
    });
  }

  /**
   * Will the written row be its provider's DEFAULT?
   *
   * The rule is short and every refusal below depends on it: a provider group
   * always has exactly one default, the first row to exist takes the job, and an
   * explicit `isDefault: true` moves it. `isDefault: false` can only ever mean
   * "make some OTHER row the default", which is not a statement this row can
   * make — so it is refused rather than silently leaving the group headless.
   */
  private resolveDefaultIntent(
    dto: UpsertAiProviderConnectionRequest,
    existing: AiProviderConnectionEntity | null,
    currentDefault: AiProviderConnectionEntity | null,
  ): boolean {
    const isCurrentDefault = existing != null && currentDefault != null && existing.id === currentDefault.id;
    if (dto.isDefault === false) {
      if (isCurrentDefault || currentDefault == null) {
        throw new BadRequestException({
          code: CONNECTION_ERROR_CODES.DEFAULT_REQUIRED,
          message:
            'Every provider needs exactly one default connection, and this is (or would be) it. Send `isDefault: true` ' +
            'on the connection that should take over instead — that flip clears this one in the same transaction.',
        });
      }
      return false;
    }
    if (dto.isDefault === true) return true;
    // No opinion: an existing row keeps its job, a new row takes it only when
    // the provider has no default yet.
    return existing ? existing.isDefault : currentDefault == null;
  }

  /**
   * D-9, platform half — the SYSTEM tier is ONE row per provider, named after
   * it, and always that provider's default. It is the fallback every tenant
   * inherits BY PROVIDER NAME, so a second row there, or a demoted one, is a
   * value no cascade could ever reach.
   */
  private assertPlatformTierShape(slug: string, provider: string, dto: UpsertAiProviderConnectionRequest, scopedTenantId: string): void {
    if (scopedTenantId !== SYSTEM_TENANT_ID) return;
    if (slug === provider && dto.isDefault !== false) return;
    throw new BadRequestException({
      code: CONNECTION_ERROR_CODES.PLATFORM_ONE_PER_PROVIDER,
      message:
        'The platform tier holds exactly one connection per provider, and it is that provider’s default: its name ' +
        `must be the provider id ('${provider}') and it cannot be demoted. Named connections are a tenant-tier ` +
        'facility — the platform row is the fallback every tenant inherits BY PROVIDER NAME, so a second one there ' +
        'is a value no cascade could reach.',
      slug,
      provider,
    });
  }

  /**
   * D-9, tenant half — WHERE a named sibling is allowed at all.
   *
   * The integration planes (`embeddings`/`rerank`/`vector`/`model-registry`)
   * execute no per-tenant model rows, so nothing could ever bind a sibling by
   * id — the same reasoning that keeps them out of `BYO_DECLARABLE_SERVICES`. A
   * row nothing can address is worse than a named refusal. Their DEFAULT row is
   * untouched.
   */
  private assertMultiplicityAllowed(service: ProviderService, slug: string, provider: string, scopedTenantId: string, willBeDefault: boolean): void {
    if (scopedTenantId === SYSTEM_TENANT_ID) return;

    if (!willBeDefault && !isByoDeclarableService(service)) {
      throw new BadRequestException({
        code: CONNECTION_ERROR_CODES.MULTIPLICITY_UNSUPPORTED,
        message:
          `The '${service}' capability resolves its provider by name and serves no per-tenant model rows, so a second ` +
          `'${provider}' connection could never be selected. Services that support named connections: ` +
          `${BYO_DECLARABLE_SERVICES.join(', ')}.`,
        slug,
        service,
        provider,
      });
    }
  }

  /**
   * D-8 — the plan ceiling on how many connections one tenant may hold, across
   * every service. CREATE only (existing rows are grandfathered, the house
   * "block-new" rule), and never on the platform tier: the platform does not
   * bound itself.
   *
   * `null` on every seeded plan today, so this is unbounded until an operator
   * sets a cap — entitlements BOUND, they never supply.
   */
  private async assertConnectionQuota(scopedTenantId: string, tx?: CoreDatabaseService['baseClient']): Promise<void> {
    if (scopedTenantId === SYSTEM_TENANT_ID || !this.entitlementsService) return;
    const current = await this.countTenantConnections(scopedTenantId, tx);
    await this.entitlementsService.assertQuantityQuota(scopedTenantId, MAX_AI_PROVIDER_CONNECTIONS_KEY, current);
  }

  /** Live connections this tenant holds, across every service (the quota's subject). */
  private async countTenantConnections(scopedTenantId: string, tx?: CoreDatabaseService['baseClient']): Promise<number> {
    const perService = await Promise.all(PROVIDER_SERVICES.map((service) => this.readTier(service, scopedTenantId)));
    void tx;
    return perService.reduce((total, rows) => total + rows.length, 0);
  }

  /**
   * Run `work` with the previous default cleared FIRST, in ONE transaction.
   *
   * The order is forced by the database, not by taste: `(tenantId, service,
   * defaultForProvider)` is unique, so setting the new default before clearing
   * the old one is a constraint violation. Doing both in one transaction is what
   * keeps "exactly one default per provider" true even if the second write
   * fails — a provider group with two defaults, or none, is unresolvable.
   *
   * When nothing needs clearing the work runs on the caller's own lane, so the
   * ordinary edit costs no transaction.
   */
  private async withDefaultFlip<T>(
    willBeDefault: boolean,
    currentDefault: AiProviderConnectionEntity | null,
    targetId: string | null,
    tx: CoreDatabaseService['baseClient'] | undefined,
    work: (lane?: CoreDatabaseService['baseClient']) => Promise<T>,
  ): Promise<T> {
    const mustClear = willBeDefault && currentDefault != null && currentDefault.id !== targetId;
    if (!mustClear) return work(tx);

    const previous = currentDefault!;
    return this.databaseService.baseClient.$transaction(async (client) => {
      const lane = client as unknown as CoreDatabaseService['baseClient'];
      const previousVersion = previous.version;
      await this.updateEntity(previous, { defaultForProvider: null });
      await this.connectionRepository.updateWithVersion(previous.id, previous, previousVersion, lane);
      const result = await work(lane);
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: previous.id,
        data: {
          tenantId: previous.tenantId,
          service: previous.service,
          provider: previous.provider,
          slug: previous.slug,
          action: 'connection-default-cleared',
        },
      });
      return result;
    });
  }

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
