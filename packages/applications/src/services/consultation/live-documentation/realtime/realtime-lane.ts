/**
 * the REALTIME LANE: what the live flush actually executes.
 *
 * ## What this replaces
 *
 * `LiveDocumentationService.flush()` ran a hardcoded sequence — TEXT, then NER
 * over the raw delta, then the groundedness gate — for every recording session,
 * regardless of what the tenant had authored (the root cause this
 * ticket exists to close). A lane is that sequence expressed as DATA: an ordered
 * list of stages whose nodes carry their own bindings, budgets and failure
 * policy, so the executor walks a structure instead of running a script.
 *
 * ## Where a lane comes from
 *
 * Either the tenant's published `consultation`-palette graph (its
 * `compiledConfig`, filtered to the nodes the realtime runtime can execute) or
 * {@link PLATFORM_REALTIME_LANE}, which encodes today's behaviour exactly. A
 * tenant that has authored nothing therefore gets byte-identical behaviour —
 * that is the parity claim the cutover rests on, and it is a property of this
 * constant, not of a code path that happens to agree.
 *
 * ## Lane membership comes from `WorkflowNodeDescriptor.lane`
 *
 * It did not, and the reasons it could not are worth keeping because both were
 * removed rather than worked around:
 *
 *  1. `nodeDescriptorContractProblems` (`port-validation.ts`) refused a
 *     `realtime` node that was `externalWrite: true` — which both
 *     `consultation.realtimeSummary` and `consultation.extractEntities` are.
 *     That rule was written before this runtime existed and this runtime
 *     falsifies it: publishing the running note to the live feed IS the realtime
 *     lane's product. The rule is gone; see that function's docstring.
 *  2. Nothing read `lane`. The durable interpreter now does — `lane` is a shared
 *     registry field and `_dispatch_node` SKIPS a `realtime` node with
 *     `reason="realtime_lane"` (`apps/harness/.../interpreter/workflow.py`), so
 *     exactly one runtime executes a given node and the "two engines writing one
 *     consultation's document" hazard is closed structurally.
 *
 * `REALTIME_NODE_TYPES` (`realtime-node-registry.ts`) is therefore DERIVED from
 * the contract rather than hand-kept beside it, and `REALTIME_NODE_HANDLERS` is
 * asserted total over it — a node flipped to `realtime` with no handler here is a
 * failing test, not a silent no-op at flush time.
 */
import type { CompiledInputBinding, CompiledWorkflowConfig } from '@arcaai/workflow-contract';
import { canonicalRealtimeNodeType, isRealtimeNode } from './realtime-node-registry';

/** One executable node of the realtime lane, derived from a `CompiledNode`. */
export interface RealtimeNode {
  readonly nodeId: string;
  /** Registered node type, e.g. `consultation.realtimeSummary`. */
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * PER-NODE budget. Not per flush: one slow model must never stall the
   * other, so each node races its own timer.
   */
  readonly timeoutMs: number;
  /** PER-NODE retry ceiling, from the compiled `retry.maximumAttempts`. */
  readonly maxAttempts: number;
  /** Declared port bindings — `fromPort`/`toPort`, resolved by the executor. */
  readonly inputs: readonly CompiledInputBinding[];
  /** `degrade` contributes nothing and emits a typed event; `fail` fails the lane. */
  readonly onError: 'fail' | 'degrade';
  /** `config.enabled === false` — authored OFF, so the executor skips it. */
  readonly enabled: boolean;
}

/** Nodes in one topological level. Every node in a stage runs CONCURRENTLY. */
export interface RealtimeStage {
  readonly stageIndex: number;
  readonly nodes: readonly RealtimeNode[];
}

export interface RealtimeLane {
  /** WHERE the lane came from — reported on every trajectory and every degrade event. */
  readonly source: 'platform-default' | 'tenant-graph';
  readonly definitionSlug: string | null;
  readonly definitionVersionNumber: number | null;
  readonly stages: readonly RealtimeStage[];
  /**
   * TASK-890 §3.14 — the WORKFLOW-level guardrail opinion, from the compiled graph's
   * `policyBindings.guardrail` (authored on `core.trigger`). `null` = the workflow says
   * nothing, which is INHERIT, not "off": `resolveGuardrailDecision` then falls through to the
   * agent's own decision and finally to ON. The durable lane reads the same compiled fact, so
   * one node cannot be screened on one lane and skipped on the other.
   */
  readonly guardrail: boolean | null;
}

/** Node ids of the platform-default lane — stable, because trajectories cite them. */
export const PLATFORM_LANE_NODE_IDS = Object.freeze({
  capture: 'capture',
  extract: 'extract',
  summarize: 'summarize',
});

const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
const DEFAULT_NLP_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 1_000;

/**
 * The PLATFORM lane — today's flush, as a graph.
 *
 * ```
 * stage 0 capture -> transcript
 * stage 1 extract (in: transcript) -> entities ┐ concurrent
 *           summarize (in: transcript) -> document ┘
 * ```
 *
 * `extract` and `summarize` BOTH read the transcript and neither reads the
 * other, so they are one topological level and run concurrently. That is not an
 * optimisation bolted onto the old order — it is what the dependency graph
 * actually says, and the old serial order was an artifact of the hardcoded
 * script.
 *
 * `summarize.entities` is deliberately LEFT UNWIRED even though the port exists.
 * Wiring it would make the note wait for NER, serialising the two calls and
 * changing what the model is told — neither of which today's behaviour does.
 *
 * There is no groundedness NODE because the registry has no groundedness node
 * type; the gate is a GUARD attached to the generation node (see `guard-memo.ts`).
 */
export const PLATFORM_REALTIME_LANE: RealtimeLane = Object.freeze({
  source: 'platform-default',
  definitionSlug: null,
  definitionVersionNumber: null,
  // The platform lane has no author, so it expresses no workflow-level guardrail opinion.
  guardrail: null,
  stages: Object.freeze([
    Object.freeze({
      stageIndex: 0,
      nodes: Object.freeze([
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.capture,
          type: 'consultation.captureBinding',
          config: Object.freeze({}),
          timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([]),
          onError: 'fail',
          enabled: true,
        } as RealtimeNode),
      ]),
    } as RealtimeStage),
    Object.freeze({
      stageIndex: 1,
      nodes: Object.freeze([
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.extract,
          type: 'consultation.extractEntities',
          config: Object.freeze({}),
          timeoutMs: DEFAULT_NLP_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([{ fromNodeId: PLATFORM_LANE_NODE_IDS.capture, fromPort: 'out', toPort: 'in' }]),
          // Entity extraction failing has never stopped the note being published.
          onError: 'degrade',
          enabled: true,
        } as RealtimeNode),
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.summarize,
          type: 'consultation.realtimeSummary',
          config: Object.freeze({}),
          timeoutMs: DEFAULT_TEXT_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([{ fromNodeId: PLATFORM_LANE_NODE_IDS.capture, fromPort: 'out', toPort: 'in' }]),
          // A TEXT failure retains the last-good note and sets `textFailed` — it
          // has never failed the flush, and must not start to.
          onError: 'degrade',
          enabled: true,
        } as RealtimeNode),
      ]),
    } as RealtimeStage),
  ]),
});

function toMs(seconds: unknown, fallbackMs: number): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallbackMs;
}

/**
 * Derive the realtime lane from a tenant's compiled graph.
 *
 * Filters each compiled stage to the node types this runtime implements, drops
 * empty stages, and RENUMBERS `stageIndex` densely — the same treatment
 * `compile()` gives its own stages, so the lane's ordering contract does not
 * depend on which durable nodes happened to sit between two realtime ones.
 *
 * Bindings whose producer was filtered out are dropped WITH the binding, not
 * silently retained: a binding pointing at a node that will never run in this
 * lane would look like an unresolved contract violation to the executor, which
 * is a different (and much louder) thing than "that value comes from the durable
 * lane". Such a node keeps its remaining bindings and resolves the missing input
 * from the run context, exactly as the platform lane's own nodes do.
 *
 * Returns `null` when the graph contributes no realtime nodes at all — the
 * caller then serves {@link PLATFORM_REALTIME_LANE}, because a consultation with
 * no documentation is a worse clinical outcome than one documented by the
 * default lane.
 */
export function buildRealtimeLane(compiled: CompiledWorkflowConfig | null | undefined): RealtimeLane | null {
  if (!compiled || !Array.isArray(compiled.stages)) return null;

  const admitted = new Set<string>();
  for (const stage of compiled.stages) {
    for (const node of stage.nodes ?? []) {
      // TASK-864 A5: admission is per INSTANCE — a `core.agent`/`core.action` joins the lane by
      // its own `execution.lane`, every legacy type by its descriptor's, as before.
      if (isRealtimeNode(node.type, node.config)) admitted.add(node.nodeId);
    }
  }
  if (admitted.size === 0) return null;

  const stages: RealtimeStage[] = [];
  for (const stage of compiled.stages) {
    const nodes = (stage.nodes ?? [])
      .filter((node) => admitted.has(node.nodeId))
      .map<RealtimeNode>((node) => ({
        nodeId: node.nodeId,
        type: node.type,
        config: node.config ?? {},
        timeoutMs: toMs(node.timeoutSeconds, DEFAULT_TEXT_TIMEOUT_MS),
        maxAttempts: Math.max(1, node.retry?.maximumAttempts ?? 1),
        inputs: (node.inputs ?? []).filter((binding) => admitted.has(binding.fromNodeId)),
        onError: node.onError === 'fail' ? 'fail' : 'degrade',
        enabled: node.config?.enabled !== false,
      }));
    if (nodes.length === 0) continue;
    stages.push({ stageIndex: stages.length, nodes });
  }

  if (stages.length === 0) return null;

  return {
    source: 'tenant-graph',
    definitionSlug: compiled.slug ?? null,
    definitionVersionNumber: compiled.versionNumber ?? null,
    stages,
    guardrail: compiled.policyBindings?.guardrail?.enabled ?? null,
  };
}

/**
 * TASK-891 D7 — the `DocumentTemplate.slug` the governing workflow's realtime summary node
 * names, or `null` when the lane names none.
 *
 * ## Why this read did not exist
 *
 * `ensureTemplateResolved` called `resolveForGeneration(session.tenantId)` and passed no
 * slug, even though the method has ACCEPTED an optional `slug` since it was written. The
 * traced 2026-09-07 session therefore logged `templateId: null` and produced the platform
 * shape, while its governing workflow (`arcaai-consultation-medical-ner`) was right there
 * on the frozen lane. The workflow is where a tenant expresses "this department, this visit
 * type, this note shape" — reading it is the whole of OD-2's third wire-up.
 *
 * A node's `config` is `Readonly<Record<string, unknown>>` by contract, so this needs no
 * schema change; a non-string or blank value is treated as "the lane named none" rather
 * than passed on, because `resolveForGeneration` would then look up a slug nobody authored
 * and fail open to the platform shape anyway — with the cause hidden one layer further in.
 */
export function realtimeDocumentTemplateSlug(lane: RealtimeLane | null): string | null {
  if (!lane) return null;
  for (const stage of lane.stages) {
    for (const node of stage.nodes) {
      if (canonicalRealtimeNodeType(node.type, node.config) !== 'consultation.realtimeSummary') continue;
      const slug = node.config.documentTemplateSlug;
      if (typeof slug === 'string' && slug.trim().length > 0) return slug.trim();
    }
  }
  return null;
}
