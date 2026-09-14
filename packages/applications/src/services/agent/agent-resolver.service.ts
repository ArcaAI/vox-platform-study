import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import {
  AgentEntity,
  AgentModelFallbackRepository,
  AgentRepository,
  AgentTask,
  AiModelEntity,
  AiModelRepository,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import type { AgentCompiledConfig, ResolvedAgent, ResolvedAgentModel, ResolvedAgentModelRole } from '@arcaai/types';
import type { IActiveUserContext } from '../../interfaces';
import { AGENT_TASK_SERVICE } from '@arcaai/workflow-contract';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type { IProviderConnectionService as IProviderConnectionServicePort } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider, type ProviderService } from '../ai-provider-connection/constants';
import { ProviderCredentialResolver } from '../ai-provider-connection/provider-credential-resolver';
import { derivedLocalPath } from '../ai-model/constants';
import { runInTenantContext } from '../agentPromotion/tenant-context';
import { isPlatformHiddenAgentSlug } from './platform-hidden-agents';

export interface ResolveAgentInput {
  tenantId: string;
  task?: AgentTask;
  agentSlug?: string | null;
  departmentId?: string | null;
  /**
   * TASK-884's `key:value` selector tags, carried into the assignment cascade so a tier can
   * hold more than one opinion (TASK-891: `phase:live` vs the unqualified finalize row).
   *
   * Ignored on the explicit-slug path — the caller already named the agent — and OMITTED from
   * the cascade call entirely when empty, so every existing caller resolves byte-identically.
   */
  selectorTags?: readonly string[];
  /**
   * TASK-958 — what to do when the PRIMARY model NAMES a connection that cannot serve
   * (disabled, keyless, or an id this tenant cannot read).
   *
   * `fail-closed` (the DEFAULT) throws {@link AGENT_CONNECTION_UNAVAILABLE}. It is the
   * default because the dangerous answer is the quiet one: this method used to return an
   * agent with NO `providerOverride`, and every caller that folds by provider NAME
   * (`AgentInvocationService`, the bench) then injected the tenant's DEFAULT account —
   * spending a vendor account the binding did not name, and metering it there.
   *
   * `mark` is for the CHAIN planes (text / TTS / ASR / the realtime read-outs), which
   * resolve a credential PER CANDIDATE of their own chain: there the primary's failure
   * means "skip this candidate and walk on" (D-3), so a throw here would take out a
   * fallback that was configured precisely for this case.
   */
  primaryBinding?: PrimaryBindingPolicy;
  /**
   * TASK-974 D-1 — opt IN to resolving a PLATFORM HIDDEN agent (`PLATFORM_HIDDEN_AGENTS`).
   *
   * This resolver is the ONE by-slug chokepoint every runtime call goes through — the invoke /
   * speech / transcription routes, a `core.agent` node, the realtime lane — so it is where the
   * business plane's blindness to a hidden agent is enforced, once, instead of at each of them.
   * Without this flag a hidden slug answers the same `NotFoundException` an unknown one does,
   * whichever tenant asked and whether it arrived explicitly or through the cascade.
   *
   * The ONLY caller that sets it is the platform service that OWNS the capability (the DNA
   * writing-style processor). It is a named opt-in rather than an implicit "SYSTEM tenant may"
   * carve-out for exactly that reason: an opt-in is greppable, and a carve-out is a back door
   * nobody would notice widening.
   */
  allowPlatformHidden?: boolean;
}

/** @see ResolveAgentInput.primaryBinding */
export type PrimaryBindingPolicy = 'fail-closed' | 'mark';

/**
 * TASK-958 — the agent's PRIMARY model names a connection that cannot serve.
 *
 * A 409 (not a 404): the agent exists and the caller may see it; what is unavailable is
 * the vendor account it is bound to. The body names `agentSlug`, `modelSlug` and
 * `connectionId` so an admin can go straight to the row that is disabled or keyless.
 */
export const AGENT_CONNECTION_UNAVAILABLE = 'AGENT_CONNECTION_UNAVAILABLE';

/** The identity facts of one `AiProviderConnection` row that the WIRE needs. */
export interface ConnectionIdentity {
  id: string;
  slug: string;
  provider: string;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

/**
 * TASK-958 (F6) — the key ONE connection's credential travels under in `provider_overrides`.
 *
 * `provider` for the tenant's DEFAULT row and for every SYSTEM row (which is always its
 * provider's default), so every payload that existed before multiplicity is byte-identical;
 * `provider:slug` for a named sibling.
 *
 * The namespace matters as much as the uniqueness. Keying a sibling by its BARE slug put
 * tenant-chosen names into the same space as provider ids, so a tenant that called its
 * second Sarvam account `azure` would overwrite — or be read as — the `azure` entry. A
 * provider id never contains `:`, so the two spaces cannot meet.
 *
 * `isDefault` is READ from the row, never inferred: a tenant may promote a sibling and
 * demote the original, leaving a NON-default row whose slug still equals the provider id.
 * Inferring from the name there would hand two different rows the same key. When the row
 * could not be read at all (no connection plane wired) the naming convention is the
 * fallback — degraded, but never an alias of another row's key.
 */
export function providerOverrideKey(provider: string, connection?: { slug?: string | null; isDefault?: boolean } | null): string {
  const slug = connection?.slug ?? null;
  if (!slug) return provider;
  const isDefault = connection?.isDefault ?? slug === provider;
  return isDefault ? provider : `${provider}:${slug}`;
}

/**
 * TASK-958 (F7) — the key a binding that FAILED CLOSED is stamped with.
 *
 * Always namespaced, never the bare provider id, and that is the whole point: the map
 * holds NO entry for a connection that could not serve, so the consumer must MISS. Under
 * the bare provider key it would hit the DEFAULT row's entry instead (an enabled-but-keyless
 * sibling still lets the provider-name cascade resolve the platform row), and the chain
 * would authenticate as an account the tenant never bound it to.
 *
 * The row id is the last-resort discriminator for a row whose slug could not be read.
 */
export function failedBindingKey(provider: string, slug: string | null | undefined, connectionId: string): string {
  return `${provider}:${slug && slug.length > 0 ? slug : connectionId}`;
}

/**
 * TASK-958 — ONE masked read of a tenant's connection rows per resolve, shared by every
 * candidate of a chain.
 *
 * The wire key depends on a fact only the ROW carries (`isDefault`), and a chain can name
 * several connections, so the alternative is one lookup per candidate. Lazy: a tenant whose
 * models name no connection never issues it. Fail-soft: a lookup failure degrades to the
 * naming convention in {@link providerOverrideKey} rather than failing a synthesis or a
 * transcription — this read decides a KEY, never whether a credential may be used.
 */
export class ConnectionIdentityLookup {
  private rows?: Promise<ConnectionIdentity[]>;

  constructor(
    private readonly connections: { list?: (service: ProviderService, tenantId?: string) => Promise<unknown[]> } | undefined,
    private readonly service: ProviderService,
    private readonly tenantId: string,
  ) {}

  async byId(connectionId: string): Promise<ConnectionIdentity | null> {
    return (await this.load()).find((row) => row.id === connectionId) ?? null;
  }

  /** Every NON-default row of one provider that could actually serve (enabled + keyed). */
  async siblings(provider: string): Promise<ConnectionIdentity[]> {
    return (await this.load()).filter((row) => row.provider === provider && !row.isDefault && row.enabled && row.hasKey);
  }

  private load(): Promise<ConnectionIdentity[]> {
    if (!this.rows) {
      const list = this.connections?.list;
      this.rows = !list
        ? Promise.resolve([])
        : Promise.resolve(list.call(this.connections, this.service, this.tenantId))
            .then((rows) =>
              (rows as ConnectionIdentity[]).map((row) => ({
                id: String(row.id),
                slug: String(row.slug),
                provider: String(row.provider),
                isDefault: row.isDefault === true,
                enabled: row.enabled !== false,
                hasKey: row.hasKey === true,
              })),
            )
            .catch(() => []);
    }
    return this.rows;
  }
}

/** Where the ASR spec references auxiliary registry models (TASK-861 §3.2). */
const ASR_AUX_MODEL_PATHS: ReadonlyArray<{ role: ResolvedAgentModelRole; path: readonly string[] }> = [
  { role: 'vad', path: ['audioFrontEnd', 'vad', 'modelSlug'] },
  { role: 'denoise', path: ['audioFrontEnd', 'denoise', 'modelSlug'] },
  { role: 'embedding', path: ['audioFrontEnd', 'diarization', 'embeddingModelSlug'] },
  { role: 'punctuation', path: ['postProcessing', 'punctuation', 'modelSlug'] },
  // TASK-880 H-4 — the end-of-utterance model TASK-877 gave a role and a schema property, but no resolver path.
  { role: 'endpointing', path: ['streaming', 'semantic', 'modelSlug'] },
];

function dig(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * TASK-890 §3.14 (OD-R) — the AGENT tier of the guardrail precedence, normalised.
 *
 * `compiledConfig.guardrail` is additive-optional (every artifact published before this ticket
 * has none) and the runtime needs an ANSWER, not a maybe. Absence is INHERIT and the bottom of
 * the chain is screening ON, so absence resolves to `true`.
 *
 * A non-boolean is treated identically to absence, deliberately: publish closes the `guards`
 * object so a malformed value should be unreachable, and if one is reached anyway the call is
 * SCREENED. The failure direction on a safety gate is never "off".
 */
function guardrailOf(compiled: AgentCompiledConfig): { enabled: boolean } {
  const declared = (compiled as { guardrail?: { enabled?: unknown } }).guardrail?.enabled;
  return { enabled: typeof declared === 'boolean' ? declared : true };
}

/**
 * ONE resolution for two callers (TASK-863 §3.4): the gateway (standalone invocation, STT
 * sessions — TASK-861) and the harness `core.agent` activity (TASK-864, over
 * `GET /internal/agents/resolve`).
 *
 *  1. explicit slug → the tenant's ACTIVE PUBLISHED version; foreign / unknown / unpublished →
 *     one 404;
 *  2. else the assignment cascade `department → tenant` — no SYSTEM tier (TASK-890 OD-M);
 *     nothing assigned is a named `AGENT_NOT_ASSIGNED` 503, never a silent platform read;
 *  3. materialise: `compiledConfig` + every model row the runtime needs (primary, fallbacks,
 *     ASR auxiliaries) + the provider credential override for a cloud provider, funding tier
 *     derived from the tier that supplied the row.
 */
@Injectable()
export class AgentResolverService {
  private readonly logger = new Logger(AgentResolverService.name);

  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly fallbackRepository: AgentModelFallbackRepository,
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IAgentAssignmentService) private readonly assignments: IAgentAssignmentServicePort,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionServicePort,
    // TASK-890 H-6 — the fallback chain of a SYSTEM agent is read under the
    // AGENT's tenant, not the caller's (see `materialiseModels`). `@Optional()`
    // and trailing so the positional unit fixtures keep their arity; production
    // DI always supplies it.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
    // TASK-958 D-3 — the by-id credential lookup. `@Optional()` and TRAILING for the
    // same reason as `clsService`: positional unit fixtures keep their arity, and
    // without it a connection-bound model falls back to the provider-name fold —
    // which is what this resolver did before the binding rule existed.
    @Optional() private readonly credentials?: ProviderCredentialResolver,
  ) {}

  async resolve(input: ResolveAgentInput): Promise<ResolvedAgent> {
    const { tenantId } = input;
    let entity: AgentEntity | null;
    let source: ResolvedAgent['source'];

    if (input.agentSlug) {
      entity = await this.agentRepository.findPublishedActiveBySlug(tenantId, input.agentSlug);
      if (!entity) throw new NotFoundException('Agent not found');
      if (input.task && entity.task !== input.task) {
        throw new BadRequestException(`Agent '${input.agentSlug}' is a ${entity.task} agent; this call needs ${input.task}.`);
      }
      source = 'explicit';
    } else {
      if (!input.task) throw new BadRequestException('Either agentSlug or task is required.');
      // The empty case calls with THREE arguments on purpose. Every other caller of this
      // resolver (the ASR seam, the prompt test bench, a `core.agent` node) supplies no tags,
      // and an unqualified cascade call must stay indistinguishable from the pre-TASK-891 one.
      const selectorTags = input.selectorTags ?? [];
      const assigned =
        selectorTags.length > 0
          ? await this.assignments.resolve(tenantId, input.task, input.departmentId ?? null, selectorTags)
          : await this.assignments.resolve(tenantId, input.task, input.departmentId ?? null);
      if (!assigned.agentSlug || assigned.source === 'unassigned') {
        // TASK-890 §3.4 (OD-M) — the cascade ends at the tenant. Nothing assigned is a NAMED,
        // fail-closed 503 that says which task, in which tenant, and (when one was given) under
        // which department: the remedy is an assignment in THIS tenant, or a reference-set
        // re-sync (`POST /admin/tenants/:id/reference-set/sync`). It is deliberately not a 404 —
        // the agent is not missing, the tenant's OPINION about which agent serves this task is,
        // and a caller told "not found" would go looking for the wrong thing.
        throw new ServiceUnavailableException({
          code: 'AGENT_NOT_ASSIGNED',
          message: `No ${input.task} agent is assigned for this tenant. Assign one, or re-sync the platform reference set.`,
          task: input.task,
          tenantId,
          departmentId: input.departmentId ?? null,
        });
      }
      entity = await this.agentRepository.findPublishedActiveBySlug(tenantId, assigned.agentSlug);
      if (!entity) throw new NotFoundException('Agent not found');
      source = assigned.source;
    }

    // TASK-974 D-1 — a PLATFORM HIDDEN agent is not part of any tenant's product surface.
    // Checked on the RESOLVED row rather than on the input, so both ways in are covered with one
    // line: an explicit slug, and a slug that reached here through a (stale) assignment. The
    // answer is the same `NotFoundException` an unknown slug gets, so nothing about the platform
    // agent's existence is disclosed — including to the Global playground, which OWNS the
    // authored row and is the only tenant for which this can fire.
    if (!input.allowPlatformHidden && isPlatformHiddenAgentSlug(entity.slug)) {
      throw new NotFoundException('Agent not found');
    }

    const compiledConfig = entity.compiledConfig as unknown as AgentCompiledConfig | null;
    if (!compiledConfig || typeof compiledConfig !== 'object') {
      throw new ConflictException(`Agent '${entity.slug}' v${entity.versionNumber} is published without a compiledConfig; republish it.`);
    }

    const models = await this.materialiseModels(entity, compiledConfig, tenantId);
    const override = await this.providerOverrideFor(entity.slug, compiledConfig, models, tenantId, input.primaryBinding ?? 'fail-closed');

    return {
      agentId: entity.id,
      agentVersionId: entity.id,
      slug: entity.slug,
      versionNumber: entity.versionNumber,
      task: entity.task,
      tenantId: entity.tenantId,
      source,
      compiledConfig,
      models,
      guardrail: guardrailOf(compiledConfig),
      ...(override ? { providerOverride: override.entry, fundingTier: override.fundingTier } : {}),
    };
  }

  private async materialiseModels(entity: AgentEntity, compiled: AgentCompiledConfig, tenantId: string): Promise<ResolvedAgentModel[]> {
    const out: ResolvedAgentModel[] = [];
    const primary = (await this.modelById(compiled.model.id, tenantId)) ?? (await this.modelBySlug(compiled.model.slug, tenantId));
    if (!primary)
      throw new ConflictException(`Agent '${entity.slug}' binds model '${compiled.model.slug}', which is no longer visible to this tenant.`);
    out.push(toResolvedModel(primary, 'primary'));

    // TASK-890 H-6. `AgentModelFallback` is tenant-scoped and NOT shared-read, so
    // this read under the CALLER's tenant returns `[]` for a SYSTEM agent — a
    // silently fallback-less resolve rather than an error. The fix is CONTEXT,
    // not a widening of the shared-read set: the chain belongs to the agent, so
    // it is read standing in the agent's own tenant, exactly as the
    // membership-bounded sync does. The wrap inherits the CLS store (user,
    // correlation id) and restores the caller's tenant on return.
    const fallbacks = await this.inAgentTenant(entity.tenantId, () => this.fallbackRepository.findByAgentId(entity.id));
    for (const link of fallbacks.filter((row) => row.enabled).sort((a, b) => a.priority - b.priority)) {
      const model = await this.modelById(link.modelId, tenantId);
      if (model) out.push({ ...toResolvedModel(model, 'fallback'), priority: link.priority });
    }

    if (entity.task === AgentTask.SPEECH_TO_TEXT) {
      for (const aux of ASR_AUX_MODEL_PATHS) {
        const slug = dig(compiled.parameters, aux.path);
        if (typeof slug !== 'string' || slug.length === 0) continue;
        const model = await this.modelBySlug(slug, tenantId);
        if (!model)
          throw new ConflictException(`Agent '${entity.slug}' references ${aux.role} model '${slug}', which is not visible to this tenant.`);
        out.push(toResolvedModel(model, aux.role));
      }
    }
    return out;
  }

  /**
   * Run one read under the AGENT's tenant. Without a CLS service (positional
   * unit fixtures) the read happens as before — the wrap is the only behaviour
   * this adds, and it can only ever widen what a SYSTEM agent sees of its OWN
   * rows.
   */
  private inAgentTenant<T>(agentTenantId: string, work: () => Promise<T>): Promise<T> {
    if (!this.clsService) return work();
    return runInTenantContext(this.clsService, agentTenantId, work);
  }

  /**
   * The ONE-HOP credential for the agent's PRIMARY model.
   *
   * TASK-958 D-3 — the PRIMARY MODEL ROW decides which account is spent, not the
   * provider name. When the row was declared on a connection (`sourceConnectionId`)
   * that connection serves or nothing does: it is NEVER widened to the tenant's
   * default, which would spend a different vendor account than the one the binding
   * named.
   *
   * What "nothing does" MEANS is the caller's policy (F11). Returning a bare `null`
   * — this method's original answer — is indistinguishable from "this agent has no
   * cloud credential at all", and the two call sites that fold by provider NAME then
   * injected the DEFAULT connection's key. So a named-but-unusable connection is a
   * 409 under the default policy, and only a plane that walks its own fallback chain
   * asks for `mark`. An id outside the two tiers this tenant may read is treated the
   * same way: the resolver raises a 404 for it, which here means the binding is
   * broken, not that the AGENT is missing.
   *
   * A SYSTEM catalogue row names no connection, so it keeps the provider-NAME fold:
   * `resolveTenantCloudOverrides` returns only DEFAULT rows (B1), which is
   * byte-for-byte the pre-958 cascade.
   */
  private async providerOverrideFor(
    agentSlug: string,
    compiled: AgentCompiledConfig,
    models: ResolvedAgentModel[],
    tenantId: string,
    policy: PrimaryBindingPolicy,
  ): Promise<{ entry: ResolvedAgent['providerOverride']; fundingTier: ResolvedAgent['fundingTier'] } | null> {
    const provider = compiled.model.provider;
    const service = AGENT_TASK_SERVICE[compiled.task];
    if (!provider || !this.providerConnections || !isCloudByoProvider(service, provider)) return null;

    const primary = models.find((m) => m.role === 'primary');
    const connectionId = primary?.sourceConnectionId ?? null;
    if (connectionId && this.credentials) {
      const binding = await this.credentials.resolve(service, provider, tenantId, { connectionId }).catch((error: unknown) => {
        if (!(error instanceof NotFoundException)) throw error;
        // Unknown, deleted or another tenant's. Logged with the ids because that is the
        // only way an admin can tell a mistyped binding from a revoked connection.
        this.logger.warn({
          message: 'Agent primary model names a connection this tenant cannot read; failing the binding closed',
          tenantId,
          agentSlug,
          modelSlug: primary?.slug ?? compiled.model.slug,
          connectionId,
          provider,
        });
        return null;
      });
      if (binding) return { entry: { provider, ...binding.override }, fundingTier: binding.fundingTier };
      if (policy === 'fail-closed') {
        throw new ConflictException({
          code: AGENT_CONNECTION_UNAVAILABLE,
          message:
            `Agent '${agentSlug}' binds model '${primary?.slug ?? compiled.model.slug}' to a ${provider} connection that cannot serve ` +
            '(disabled, missing its key, or no longer visible to this tenant). Enable or re-key that connection, or re-declare the model.',
          agentSlug,
          modelSlug: primary?.slug ?? compiled.model.slug,
          connectionId,
        });
      }
      this.logger.warn({
        message: 'Agent primary model names a connection that cannot serve; the chain continues without it',
        tenantId,
        agentSlug,
        modelSlug: primary?.slug ?? compiled.model.slug,
        connectionId,
        provider,
      });
      return null;
    }

    const resolved = await this.providerConnections.resolveTenantCloudOverrides(service, tenantId);
    const entry = resolved.overrides[provider];
    if (!entry) return null;
    return { entry: { provider, ...entry }, fundingTier: entry.funding };
  }

  private async modelById(id: string, tenantId: string): Promise<AiModelEntity | null> {
    const model = await this.aiModelRepository.findById(id).catch(() => null);
    return model && (model.tenantId === tenantId || model.tenantId === SYSTEM_TENANT_ID) ? model : null;
  }

  private async modelBySlug(slug: string, tenantId: string): Promise<AiModelEntity | null> {
    const own = tenantId === SYSTEM_TENANT_ID ? null : await this.aiModelRepository.findBySlug(tenantId, slug).catch(() => null);
    if (own) return own;
    return this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug).catch(() => null);
  }
}

function toResolvedModel(model: AiModelEntity, role: ResolvedAgentModelRole): ResolvedAgentModel {
  return {
    role,
    slug: model.slug,
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? null,
    // TASK-890 §3.11 — DERIVED from the bucket identity, never the column L2
    // drops. The wire value is unchanged; only its source is.
    localPath: derivedLocalPath(model),
    // TASK-890 §3.1 — the ROUTED vendor id, beside the locator `sourceUri`.
    wireModelId: model.wireModelId ?? null,
    checksum: model.checksum ?? null,
    format: String(model.format),
    // TASK-944 (B2) — the loader-SELECTION facet (TASK-860). NOT NULL on the row;
    // guarded anyway so a partially-built test entity does not emit `undefined`
    // as a declared library, which the STT side would fail closed on.
    ...(model.libraryName ? { libraryName: String(model.libraryName) } : {}),
    computeType: model.computeType ?? null,
    provider: model.provider ?? null,
    tenantId: model.tenantId,
    // TASK-958 D-3 — "the model row names the connection". OMITTED rather than
    // nulled, like `libraryName` and `metaData`: this shape crosses to the harness
    // over `GET /internal/agents/resolve`, and an unset optional must be missing
    // rather than `null` so the two halves stay independently deployable.
    ...(model.sourceConnectionId ? { sourceConnectionId: model.sourceConnectionId } : {}),
    // TASK-880 H-4 — the runtime-relevant slice of `AiModel._metadata`: ASR decode geometry (which
    // replaced `stt.whisperCpp.maxAudioSeconds` / `stt.streaming.partialWindowS`) and the
    // speaker-embedding width the ASR spec builder validates. `buildResolvedAsrSpec` reads only the
    // declared members; everything else in `_metadata` belongs to other planes.
    ...(model.metaData ? { metaData: model.metaData as ResolvedAgentModel['metaData'] } : {}),
  };
}
