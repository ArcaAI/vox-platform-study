import { Injectable, Logger } from '@nestjs/common';
import {
  AgentAssignmentRepository,
  AgentModelFallbackRepository,
  AgentRepository,
  AgentTask,
  AiModelRepository,
  AiRoutingPolicyRepository,
  AiRoutingPolicyStatus,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
  WorkflowAssignmentRepository,
  WorkflowDefinitionRepository,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import {
  RESIDENCY_CONTROLLED_SERVICES,
  refFor,
  residencyServiceOf,
  type CatalogueUseRole,
  type ResidencyControlledService,
} from './model-residency.types';

/**
 * TASK-1005 §5.2 / D-4, rebuilt by TASK-1051 (F2, F3, owner decision OD-1) — the ONE
 * platform-wide snapshot of "who consumes which model", from which BOTH the implicit live-path
 * pin set (`read`) and the catalogue's reverse usage index (`ModelUsageIndexReader`, via
 * `readSnapshot`) are derived. One snapshot is what makes the two answers impossible to
 * disagree: before TASK-1051 the pin set was keyed by `(service, slug)` off assignments and the
 * usage index by `aiModelId` off agents, and the console showed a model "Always loaded — live
 * consultation" with zero consumers (Sarvam), while routing-policy and ASR-stage models that the
 * live path DOES need (Granite Guardian, GLiNER2, Silero VAD) were not pinned at all.
 *
 * ── WHAT IT READS, EXACTLY ───────────────────────────────────────────────────
 *
 * An explicit PLATFORM-INFRASTRUCTURE read across every tenant, one round of six queries in
 * parallel, then at most two more, and nothing per row:
 *
 *   1. `AgentAssignment` — ENABLED, task `SPEECH_TO_TEXT` | `TEXT_GENERATION`;
 *   2. `Agent` — every ACTIVE PUBLISHED ENABLED version (any tenant, SYSTEM included);
 *   3. `AgentModelFallback` — ENABLED, `enabled` links;
 *   4. `AiRoutingPolicy` — ACTIVE, `enabled`, not kill-switched (guardrail / NLP / judge);
 *   5. `WorkflowDefinition` — ACTIVE PUBLISHED ENABLED versions;
 *   6. `WorkflowAssignment` — ENABLED;
 *   7. (only when a `core.agent` node pins `versionNumber`) the PUBLISHED agent versions pinned;
 *   8. `AiModel` — the rows those consumers name, by id (primaries, fallbacks, routing) or by
 *      slug (ASR stage models).
 *
 * ── CONSUMERS (the `role` of a use) ──────────────────────────────────────────
 *
 *  - `primary`        — `Agent.modelId` of an active published agent;
 *  - `fallback`       — an enabled `AgentModelFallback` of such an agent;
 *  - `routing`        — `AiRoutingPolicy.modelId` of an ACTIVE policy;
 *  - `pipeline_stage` — an ASR agent's auxiliary model (`vad`, `denoise`, `embedding`,
 *    `punctuation`, `endpointing`), named BY SLUG in its parameters and resolved exactly like
 *    the agent resolver does — the agent's own tenant's row first, then SYSTEM's. A front-end
 *    stage the agent switched OFF ships no model (`build-resolved-asr-spec.ts#auxModels`), so it
 *    is no consumer;
 *  - `workflow_node`  — the primary of the agent a `core.agent` node of a PUBLISHED workflow
 *    names (its active version, or the version the node pins).
 *
 * ── LIVE PATH (what is implicitly PINNED) ────────────────────────────────────
 *
 * A use is LIVE when it is: the primary of a LIVE agent; a stage model of a LIVE ASR agent; an
 * ACTIVE routing policy; or a node of a workflow with an ENABLED `WorkflowAssignment`. An agent
 * is live when an enabled assignment for a live task names its slug in its tenant and it has an
 * active PUBLISHED version — an assignment with no published version pins nothing — or when an
 * ASSIGNED workflow's node reaches it. Fallbacks are never pinned.
 *
 * A live use PINS its model when a residency-controlled service holds it: an ASR agent's primary
 * and stage models under `stt` (keyed by slug — apps/stt runs the resolved spec whatever the
 * row's `servedBy`), anything else under `residencyServiceOf(row)` keyed by `refFor`. A cloud
 * model no residency service holds pins nothing. `use.liveConsultation` is "live AND pinned", so
 * `usage.liveConsultation` ⇔ `aiModelId ∈ pinned set` holds BY CONSTRUCTION.
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 *
 *  - NOT a tenant → SYSTEM cascade. Content (agents, workflows) is CLONED per tenant (rule 00
 *    §"Content is cloned; configuration cascades"); this is the union of every tenant's own rows,
 *    SYSTEM read only as one more tenant. "Global" is one more customer tenant, never a tier.
 *  - NOT a replay of each tenant's resolution order: pinning a model that is not strictly on the
 *    path costs memory, never a cold load — the safe direction.
 *
 * Runs outside any request CLS (the tenant-scope extension passes through) or inside a platform
 * admin's tenant-less request (elevated pass-through). Cached platform-wide for
 * `MODEL_CONSUMER_CACHE_MS`.
 */

/** One model the live path needs resident. */
export interface LivePathModel {
  service: ResidencyControlledService;
  modelRef: string;
  aiModelId: string;
  /** The (first) consumer that put it on the live path — for the stt load spec and for the audit trail. */
  tenantId: string;
  /**
   * The agent of that consumer: the ASR agent for a `pipeline_stage`, the node's agent for a
   * `workflow_node`. For a `routing` use (no agent behind it) it is the policy's TASK KEY.
   */
  agentSlug: string;
  /** TASK-1051 — which kind of consumer put it there. Entries are ordered primary → workflow_node → pipeline_stage → routing. */
  role: Exclude<CatalogueUseRole, 'fallback'>;
}

/** One consumer of one model, as the snapshot records it (the usage index projects it onto the DTO). */
export interface ModelConsumerUse {
  tenantId: string;
  /** `null` for a `routing` use (a routing policy has no agent). */
  agentSlug: string | null;
  agentName: string;
  task: string;
  role: CatalogueUseRole;
  /** Live AND pinned — see the header. */
  liveConsultation: boolean;
  /** Identity of the consumer this use COUNTS as: `tenant|slug` for an agent, the policy id, `tenant|workflow|node`. */
  consumerKey: string;
}

export interface ModelConsumerSnapshot {
  at: number;
  /** `aiModelId` → its consumers (deduplicated per role + consumer + task). */
  uses: ReadonlyMap<string, readonly ModelConsumerUse[]>;
  /** The pin set — one entry per `(service, modelRef)`. */
  livePath: readonly LivePathModel[];
  /** Every `aiModelId` with a pin entry; `uses.get(id).some(u => u.liveConsultation)` ⇔ `pinnedModelIds.has(id)`. */
  pinnedModelIds: ReadonlySet<string>;
  /** `${tenantId}|${slug}` of every live agent whose PRIMARY is pinned. */
  liveAgentKeys: ReadonlySet<string>;
}

/** The consumer snapshot is cached this long, platform-wide (≥ 30 s: consumers change on an administrator's timescale). */
export const MODEL_CONSUMER_CACHE_MS = 30_000;

/** Tasks whose assigned agents serve the live consultation path (unchanged since TASK-1005). */
const LIVE_TASKS = [AgentTask.SPEECH_TO_TEXT, AgentTask.TEXT_GENERATION] as const;

/**
 * Where an ASR agent names a stage model BY SLUG, and which front-end switch ships it. MIRRORED
 * from `ASR_AUX_MODEL_PATHS` (`services/agent/agent-resolver.service.ts`, module-private) and the
 * stage gate of `auxModels` (`stt/agent-resolver/build-resolved-asr-spec.ts`).
 */
const ASR_STAGE_PATHS: ReadonlyArray<{ stage: string; path: readonly string[]; shipped: (afe: Rec) => boolean }> = [
  { stage: 'vad', path: ['audioFrontEnd', 'vad', 'modelSlug'], shipped: (afe) => rec(afe.vad).enabled === true },
  {
    stage: 'denoise',
    path: ['audioFrontEnd', 'denoise', 'modelSlug'],
    shipped: (afe) => rec(afe.denoise).enabled === true && rec(afe.denoise).level !== 'off',
  },
  {
    stage: 'embedding',
    path: ['audioFrontEnd', 'diarization', 'embeddingModelSlug'],
    shipped: (afe) => rec(afe.diarization).enabled === true && [undefined, 'embedding'].includes(rec(afe.diarization).backend as string | undefined),
  },
  { stage: 'punctuation', path: ['postProcessing', 'punctuation', 'modelSlug'], shipped: () => true },
  { stage: 'endpointing', path: ['streaming', 'semantic', 'modelSlug'], shipped: () => true },
];

const ROLE_ORDER: Record<LivePathModel['role'], number> = { primary: 0, workflow_node: 1, pipeline_stage: 2, routing: 3 };
const CONTROLLED: ReadonlySet<string> = new Set(RESIDENCY_CONTROLLED_SERVICES);
const EMPTY_SNAPSHOT: ModelConsumerSnapshot = { at: 0, uses: new Map(), livePath: [], pinnedModelIds: new Set(), liveAgentKeys: new Set() };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
function rec(value: unknown): Rec {
  return isRec(value) ? value : {};
}
function dig(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) cursor = isRec(cursor) ? cursor[key] : undefined;
  return cursor;
}

interface AgentRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  task: unknown;
  modelId: string;
  versionNumber?: number;
  parameters?: unknown;
  compiledConfig?: unknown;
}
interface ModelRow {
  id: string;
  tenantId: string;
  slug: string;
  sourceUri: string;
  servedBy: string;
  provider?: string | null;
  wireModelId?: string | null;
  metaData?: unknown;
}
interface AgentNode {
  nodeId: string;
  label: string;
  slug: string;
  versionNumber?: number;
}

/**
 * Every `core.agent` node of a workflow that names an agent by slug — the compiled stages AND
 * every `core.loop` body (MIRRORED from `workflowAgentNodes` in
 * `stt/agent-resolver/governing-workflow-asr.ts`, which is not imported to keep this module off
 * the consultation graph); the authored `graph.nodes` when the row carries no compiled config.
 */
function agentNodesOf(workflow: { graph?: unknown; compiledConfig?: unknown }): AgentNode[] {
  const compiled = rec(workflow.compiledConfig);
  const raw: Array<{ id: unknown; type: unknown; config: unknown }> = [];
  if (Array.isArray(compiled.stages)) {
    const stages = [...compiled.stages];
    for (const loop of Array.isArray(compiled.loops) ? compiled.loops : []) {
      const body = rec(rec(loop).body);
      if (Array.isArray(body.stages)) stages.push(...body.stages);
    }
    for (const stage of stages) {
      for (const node of Array.isArray(rec(stage).nodes) ? (rec(stage).nodes as unknown[]) : []) {
        raw.push({ id: rec(node).nodeId, type: rec(node).type, config: rec(node).config });
      }
    }
  } else {
    for (const node of Array.isArray(rec(workflow.graph).nodes) ? (rec(workflow.graph).nodes as unknown[]) : []) {
      raw.push({ id: rec(node).id, type: rec(node).type, config: rec(node).config });
    }
  }
  const authoredLabels = new Map<string, string>();
  for (const node of Array.isArray(rec(workflow.graph).nodes) ? (rec(workflow.graph).nodes as unknown[]) : []) {
    const label = rec(rec(node).config).label;
    if (typeof rec(node).id === 'string' && typeof label === 'string' && label.length > 0) authoredLabels.set(rec(node).id as string, label);
  }

  const out: AgentNode[] = [];
  for (const node of raw) {
    if (node.type !== 'core.agent') continue;
    const config = rec(node.config);
    const ref = rec(config.agentRef);
    if (typeof ref.slug !== 'string' || ref.slug.length === 0) continue; // a task-only ref names no agent
    const nodeId = typeof node.id === 'string' ? node.id : '';
    const label = typeof config.label === 'string' && config.label.length > 0 ? config.label : (authoredLabels.get(nodeId) ?? nodeId);
    const versionNumber = Number.isInteger(ref.versionNumber) && (ref.versionNumber as number) >= 1 ? (ref.versionNumber as number) : undefined;
    out.push({ nodeId, label, slug: ref.slug, ...(versionNumber !== undefined ? { versionNumber } : {}) });
  }
  return out;
}

/** The stage slugs an ASR agent ships: compiled parameters first (what the resolver reads), the authored ones otherwise. */
function stageSlugsOf(agent: AgentRow): Array<{ stage: string; slug: string }> {
  const compiled = rec(agent.compiledConfig).parameters;
  const parameters = isRec(compiled) ? compiled : rec(agent.parameters);
  const afe = rec(parameters.audioFrontEnd);
  const out: Array<{ stage: string; slug: string }> = [];
  for (const { stage, path, shipped } of ASR_STAGE_PATHS) {
    const slug = dig(parameters, path);
    if (typeof slug === 'string' && slug.length > 0 && shipped(afe)) out.push({ stage, slug });
  }
  return out;
}

@Injectable()
export class ImplicitLivePathReader {
  private readonly logger = new Logger(ImplicitLivePathReader.name);
  private cached: ModelConsumerSnapshot | null = null;

  constructor(
    private readonly assignments: AgentAssignmentRepository,
    private readonly agents: AgentRepository,
    private readonly aiModels: AiModelRepository,
    // TASK-1051 — the remaining consumer kinds; trailing so the TASK-1005 positional order holds.
    private readonly fallbacks: AgentModelFallbackRepository,
    private readonly routing: AiRoutingPolicyRepository,
    private readonly workflows: WorkflowDefinitionRepository,
    private readonly workflowAssignments: WorkflowAssignmentRepository,
  ) {}

  /** The implicit live-path set. Never throws: an unreadable set is `[]` (nothing is implicitly pinned) plus a warning. */
  async read(now = Date.now()): Promise<LivePathModel[]> {
    return [...(await this.safeSnapshot(now)).livePath];
  }

  /**
   * TASK-1005 §13 — every live agent (`${tenantId}|${slug}`) whose PRIMARY put a model on the
   * live path, from the same cached snapshot. Never throws.
   */
  async readLiveAgents(now = Date.now()): Promise<ReadonlySet<string>> {
    return (await this.safeSnapshot(now)).liveAgentKeys;
  }

  /**
   * TASK-1051 — the whole consumer snapshot (the usage index's source). A failed refresh serves
   * the last snapshot with a warning; with nothing cached the failure PROPAGATES, so a usage view
   * fails rather than reading "nobody uses it".
   */
  async readSnapshot(now = Date.now()): Promise<ModelConsumerSnapshot> {
    if (this.cached && now - this.cached.at < MODEL_CONSUMER_CACHE_MS) return this.cached;
    try {
      this.cached = await this.load(now);
      return this.cached;
    } catch (error) {
      if (!this.cached) throw error;
      this.logger.warn({
        message: 'residency.consumers.refresh_failed — serving the last snapshot',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.cached;
    }
  }

  /** Drop the cache (an admin changed an assignment and wants the view to follow now). */
  invalidate(): void {
    this.cached = null;
  }

  private async safeSnapshot(now: number): Promise<ModelConsumerSnapshot> {
    try {
      return await this.readSnapshot(now);
    } catch (error) {
      this.logger.warn({
        message: 'residency.live_path.read_failed — no model is implicitly pinned until the next read',
        error: error instanceof Error ? error.message : String(error),
      });
      return EMPTY_SNAPSHOT;
    }
  }

  private async load(now: number): Promise<ModelConsumerSnapshot> {
    const [assignmentRows, agentRows, linkRows, routeRows, workflowRows, workflowAssignmentRows] = await Promise.all([
      this.assignments.findAll({ filters: { task: { in: [...LIVE_TASKS] }, resourceStatus: ResourceStatusType.ENABLED } as never }),
      this.agents.findAll({
        filters: { isActive: true, status: WorkflowDefinitionStatus.PUBLISHED, resourceStatus: ResourceStatusType.ENABLED } as never,
      }),
      this.fallbacks.findAll({ filters: { enabled: true, resourceStatus: ResourceStatusType.ENABLED } as never }),
      this.routing.findAll({
        filters: { status: AiRoutingPolicyStatus.ACTIVE, enabled: true, killSwitch: false, resourceStatus: ResourceStatusType.ENABLED } as never,
      }),
      this.workflows.findAll({
        filters: { isActive: true, status: WorkflowDefinitionStatus.PUBLISHED, resourceStatus: ResourceStatusType.ENABLED } as never,
      }),
      this.workflowAssignments.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED } as never }),
    ]);

    const agents = agentRows as unknown as AgentRow[];
    const agentKey = (tenantId: string, slug: string) => `${tenantId}|${slug}`;
    const activeByKey = new Map(agents.map((a) => [agentKey(a.tenantId, a.slug), a]));
    const activeById = new Map(agents.map((a) => [a.id, a]));

    // Workflow nodes → the agent row each reaches (active version, or the pinned one).
    const nodes = workflowRows.flatMap((wf) => agentNodesOf(wf as never).map((node) => ({ wf, node })));
    const pinnedWanted = new Map<string, { tenantId: string; slug: string; versionNumber: number }>();
    for (const { wf, node } of nodes) {
      if (node.versionNumber === undefined) continue;
      const active = activeByKey.get(agentKey(wf.tenantId, node.slug));
      if (active && active.versionNumber === node.versionNumber) continue;
      pinnedWanted.set(`${wf.tenantId}|${node.slug}|${node.versionNumber}`, {
        tenantId: wf.tenantId,
        slug: node.slug,
        versionNumber: node.versionNumber,
      });
    }
    const pinnedRows =
      pinnedWanted.size > 0
        ? ((await this.agents.findAll({
            filters: {
              OR: [...pinnedWanted.values()],
              status: WorkflowDefinitionStatus.PUBLISHED,
              resourceStatus: ResourceStatusType.ENABLED,
            } as never,
          })) as unknown as AgentRow[])
        : [];
    const pinnedByKey = new Map(pinnedRows.map((a) => [`${a.tenantId}|${a.slug}|${a.versionNumber}`, a]));
    const nodeAgent = (tenantId: string, node: AgentNode): AgentRow | undefined =>
      node.versionNumber !== undefined
        ? (pinnedByKey.get(`${tenantId}|${node.slug}|${node.versionNumber}`) ??
          [activeByKey.get(agentKey(tenantId, node.slug))].find((a) => a?.versionNumber === node.versionNumber))
        : activeByKey.get(agentKey(tenantId, node.slug));

    // Live agents (by row id): assigned to a live task with a published active version, or reached by an assigned workflow.
    const assignedWorkflows = new Set(workflowAssignmentRows.map((row) => `${row.tenantId}|${row.workflowDefinitionSlug}`));
    const liveAgentIds = new Set<string>();
    for (const row of assignmentRows) {
      const agent = activeByKey.get(agentKey(row.tenantId, row.agentSlug));
      if (agent) liveAgentIds.add(agent.id);
    }
    for (const { wf, node } of nodes) {
      const agent = nodeAgent(wf.tenantId, node);
      if (agent && assignedWorkflows.has(`${wf.tenantId}|${wf.slug}`)) liveAgentIds.add(agent.id);
    }

    // ASR agents whose stage models count: every active one, plus pinned versions a node reaches.
    const asrAgents = [...agents, ...pinnedRows].filter((a) => a.task === AgentTask.SPEECH_TO_TEXT);
    const stageRefs = asrAgents.map((agent) => ({ agent, stages: stageSlugsOf(agent) }));

    // The model rows named.
    const ids = new Set<string>();
    for (const a of [...agents, ...pinnedRows]) ids.add(a.modelId);
    for (const l of linkRows) ids.add(l.modelId);
    for (const r of routeRows) if (r.modelId) ids.add(r.modelId);
    const slugs = new Set(stageRefs.flatMap(({ stages }) => stages.map((s) => s.slug)));
    const or: Rec[] = [];
    if (ids.size > 0) or.push({ id: { in: [...ids] } });
    if (slugs.size > 0) or.push({ slug: { in: [...slugs] } });
    const modelRows = or.length > 0 ? ((await this.aiModels.findAll({ filters: { OR: or } as never })) as unknown as ModelRow[]) : [];
    const modelById = new Map(modelRows.map((m) => [m.id, m]));
    const modelBySlug = (tenantId: string, slug: string): ModelRow | undefined =>
      (tenantId !== SYSTEM_TENANT_ID ? modelRows.find((m) => m.tenantId === tenantId && m.slug === slug) : undefined) ??
      modelRows.find((m) => m.tenantId === SYSTEM_TENANT_ID && m.slug === slug);

    // Every use, with its "live" flag (before the pin check).
    type Pending = Omit<ModelConsumerUse, 'liveConsultation'> & { modelId: string; live: boolean; asr: boolean };
    const pending: Pending[] = [];
    const agentUse = (agent: AgentRow) => ({
      tenantId: agent.tenantId,
      agentSlug: agent.slug,
      agentName: agent.name,
      task: String(agent.task),
      consumerKey: agentKey(agent.tenantId, agent.slug),
      asr: agent.task === AgentTask.SPEECH_TO_TEXT,
    });
    for (const agent of agents) pending.push({ ...agentUse(agent), modelId: agent.modelId, role: 'primary', live: liveAgentIds.has(agent.id) });
    for (const link of linkRows) {
      const agent = activeById.get(link.agentId);
      if (agent) pending.push({ ...agentUse(agent), modelId: link.modelId, role: 'fallback', live: false }); // a draft's link is no consumer
    }
    for (const route of routeRows) {
      if (!route.modelId) continue;
      pending.push({
        tenantId: route.tenantId,
        agentSlug: null,
        agentName: route.displayName || route.taskKey,
        task: route.taskKey,
        consumerKey: `routing|${route.id}`,
        asr: false,
        modelId: route.modelId,
        role: 'routing',
        live: true,
      });
    }
    for (const { agent, stages } of stageRefs) {
      for (const { stage, slug } of stages) {
        const model = modelBySlug(agent.tenantId, slug);
        if (!model) continue; // invisible stage model: the resolver degrades the stage
        pending.push({
          ...agentUse(agent),
          task: `${String(agent.task)} · ${stage}`,
          modelId: model.id,
          role: 'pipeline_stage',
          live: liveAgentIds.has(agent.id),
        });
      }
    }
    for (const { wf, node } of nodes) {
      const agent = nodeAgent(wf.tenantId, node);
      if (!agent) continue; // the node names no published agent: nothing runs
      pending.push({
        ...agentUse(agent),
        tenantId: wf.tenantId,
        agentName: `${wf.name} › ${node.label}`,
        consumerKey: `${wf.tenantId}|${wf.slug}|${node.nodeId}`,
        modelId: agent.modelId,
        role: 'workflow_node',
        live: assignedWorkflows.has(`${wf.tenantId}|${wf.slug}`),
      });
    }

    // Pins: one per (service, modelRef), the strongest consumer first.
    const livePath = new Map<string, LivePathModel>();
    const pinnedModelIds = new Set<string>();
    const liveAgentKeys = new Set<string>();
    const liveUses = pending
      .filter((u) => u.live && u.role !== 'fallback')
      .sort((a, b) => ROLE_ORDER[a.role as LivePathModel['role']] - ROLE_ORDER[b.role as LivePathModel['role']]);
    for (const use of liveUses) {
      const model = modelById.get(use.modelId);
      if (!model) continue;
      const service = use.asr ? 'stt' : residencyServiceOf(model);
      if (!service || !CONTROLLED.has(service)) continue;
      const modelRef = refFor(service, model);
      if (!modelRef) continue;
      pinnedModelIds.add(model.id);
      if (use.role === 'primary' && use.agentSlug) liveAgentKeys.add(agentKey(use.tenantId, use.agentSlug));
      const key = `${service}|${modelRef}`;
      if (!livePath.has(key)) {
        livePath.set(key, {
          service: service as ResidencyControlledService,
          modelRef,
          aiModelId: model.id,
          tenantId: use.tenantId,
          agentSlug: use.agentSlug ?? use.task,
          role: use.role as LivePathModel['role'],
        });
      }
    }

    // Uses per model, deduplicated, with liveConsultation = live AND pinned.
    const uses = new Map<string, ModelConsumerUse[]>();
    for (const { modelId, live, tenantId, agentSlug, agentName, task, role, consumerKey } of pending) {
      const list = uses.get(modelId) ?? [];
      const liveConsultation = live && role !== 'fallback' && pinnedModelIds.has(modelId);
      const same = list.find((u) => u.role === role && u.consumerKey === consumerKey && u.task === task);
      if (same) same.liveConsultation ||= liveConsultation;
      else list.push({ tenantId, agentSlug, agentName, task, role, consumerKey, liveConsultation });
      uses.set(modelId, list);
    }

    return { at: now, uses, livePath: [...livePath.values()], pinnedModelIds, liveAgentKeys };
  }
}
