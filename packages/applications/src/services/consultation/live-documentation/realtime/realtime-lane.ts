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
import type { CompiledBranchGuard, CompiledInputBinding, CompiledWorkflowConfig } from '@arcaai/workflow-contract';
import { isRealtimeNode } from './realtime-node-registry';

/** One executable node of the realtime lane, derived from a `CompiledNode`. */
export interface RealtimeNode {
  readonly nodeId: string;
  /** Registered node type — since TASK-893 every realtime node is a `core.agent` or `core.action`. */
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
  /**
   * TASK-932 D-9 — the authored `execution.cadence`, or `undefined` when the node declares none.
   *
   * Only `onStart` changes anything: it partitions the node OUT of {@link RealtimeLane.stages}
   * and into {@link RealtimeLane.onStart}. Every other value (including absent) keeps today's
   * behaviour exactly — walked on every flush — because that is what every realtime node did
   * before this cadence existed and nothing here is trying to reinterpret them.
   */
  readonly cadence: string | undefined;
  /**
   * TASK-932 — the branch handles this node sits BEHIND, kept verbatim from
   * `CompiledNode.branchGuards`. Empty for an unguarded node, which is every node of every
   * lane authored before a `core.condition` split one.
   *
   * The executor runs a guarded node only when one of these handles was taken
   * ({@link RealtimeLane.conditions}) — the same rule the durable interpreter applies in
   * `_branch_skip` (`apps/harness/.../interpreter/workflow.py`). Without it a graph that
   * splits its per-turn summary by visit type ran BOTH summary nodes on every flush: two TEXT
   * generations for one note, which is the 503 storm observed on 2026-09-09.
   */
  readonly branchGuards: readonly CompiledBranchGuard[];
}

/** One branch of a `core.condition`: the HANDLE it routes to and the CEL expression that opens it. */
export interface RealtimeConditionBranch {
  /** `branches[].key` — the same string the compiler recorded as a guard `handle`. */
  readonly key: string;
  readonly when: string;
}

/**
 * A `core.condition` node the lane must EVALUATE but never EXECUTES.
 *
 * The condition itself is a durable node (`lane: 'durable'`, `classes: ['router']`), so it is not
 * admitted to the lane and no handler exists for it. What the realtime lane needs from it is only
 * its routing decision, which is a pure function of the run context — so the branches are carried
 * here and evaluated by the executor with the SAME `evaluateCondition` the harness activity uses.
 */
export interface RealtimeCondition {
  readonly nodeId: string;
  readonly branches: readonly RealtimeConditionBranch[];
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
  /**
   * The stages a FLUSH walks: every realtime node except the `onStart` ones.
   *
   * Partitioned rather than filtered at the call site, because the executor walks whatever it is
   * given: leaving a warm-start node in here ran the pre-summary once per flush, which is a
   * second LLM call on the 20 s live budget and a second PRE_SUMMARY context item per turn.
   */
  readonly stages: readonly RealtimeStage[];
  /**
   * TASK-932 D-9 — the `onStart` nodes, in graph order, which
   * {@link LiveDocumentationService.start} runs ONCE when the session opens.
   *
   * Empty for every lane authored before this cadence existed, which is what makes the
   * partition additive.
   */
  readonly onStart: readonly RealtimeNode[];
  /**
   * TASK-890 §3.14 — the WORKFLOW-level guardrail opinion, from the compiled graph's
   * `policyBindings.guardrail` (authored on `core.trigger`). `null` = the workflow says
   * nothing, which is INHERIT, not "off": `resolveGuardrailDecision` then falls through to the
   * agent's own decision and finally to ON. The durable lane reads the same compiled fact, so
   * one node cannot be screened on one lane and skipped on the other.
   */
  readonly guardrail: boolean | null;
  /**
   * TASK-932 — the `core.condition` nodes this lane's {@link RealtimeNode.branchGuards} name.
   *
   * Only the referenced ones: a condition that gates nothing on this lane is the durable lane's
   * business and evaluating it here would be a decision nobody reads. Empty for every lane with
   * no guarded node, which makes the whole mechanism inert for a graph that authors no split.
   */
  readonly conditions: readonly RealtimeCondition[];
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
 * The PLATFORM lane — today's flush, as a `core` graph (TASK-893).
 *
 * ```
 * stage 0 capture   core.agent{SPEECH_TO_TEXT}            -> transcript
 * stage 1 extract   core.agent{NAMED_ENTITY_RECOGNITION}  (in: capture.transcript) ┐ concurrent
 *           summarize core.agent{TEXT_GENERATION}         (in: capture.transcript) ┘
 * ```
 *
 * No agent SLUG is hard-coded here (rule: configuration is never a literal in code): each node
 * references the tenant's ASSIGNED agent for its task (`agentRef: { task }`), which only this
 * code-built lane may do — a published graph must name a slug. `extract` and `summarize` both
 * read the transcript and neither reads the other, so they run concurrently.
 */
const PLATFORM_AGENT_CONFIG = (task: 'SPEECH_TO_TEXT' | 'NAMED_ENTITY_RECOGNITION' | 'TEXT_GENERATION') =>
  Object.freeze({ agentRef: Object.freeze({ task }), execution: Object.freeze({ lane: 'realtime', cadence: 'perTurn' }) });

export const PLATFORM_REALTIME_LANE: RealtimeLane = Object.freeze({
  source: 'platform-default',
  definitionSlug: null,
  definitionVersionNumber: null,
  // The platform lane has no author, so it expresses no workflow-level guardrail opinion.
  guardrail: null,
  // ...and no author means no branch: the code-built lane runs every one of its three nodes on
  // every flush, exactly as it did before guards existed.
  conditions: Object.freeze([]),
  // TASK-932 D-9 — the code-built lane declares NO warm start. The pre-summary is a node a
  // tenant AUTHORS on its graph; encoding one here would give every tenant with no graph a
  // capability they never asked for, which is exactly the "the hardcoded loop runs regardless of
  // what the tenant authored" defect this lane exists to have fixed.
  onStart: Object.freeze([]),
  stages: Object.freeze([
    Object.freeze({
      stageIndex: 0,
      nodes: Object.freeze([
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.capture,
          type: 'core.agent',
          config: PLATFORM_AGENT_CONFIG('SPEECH_TO_TEXT'),
          timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([]),
          onError: 'fail',
          enabled: true,
          cadence: 'perTurn',
          branchGuards: Object.freeze([]),
        } as RealtimeNode),
      ]),
    } as RealtimeStage),
    Object.freeze({
      stageIndex: 1,
      nodes: Object.freeze([
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.extract,
          type: 'core.agent',
          config: PLATFORM_AGENT_CONFIG('NAMED_ENTITY_RECOGNITION'),
          timeoutMs: DEFAULT_NLP_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([{ fromNodeId: PLATFORM_LANE_NODE_IDS.capture, fromPort: 'transcript', toPort: 'in' }]),
          // Entity extraction failing has never stopped the note being published.
          onError: 'degrade',
          enabled: true,
          cadence: 'perTurn',
          branchGuards: Object.freeze([]),
        } as RealtimeNode),
        Object.freeze({
          nodeId: PLATFORM_LANE_NODE_IDS.summarize,
          type: 'core.agent',
          config: PLATFORM_AGENT_CONFIG('TEXT_GENERATION'),
          timeoutMs: DEFAULT_TEXT_TIMEOUT_MS,
          maxAttempts: 1,
          inputs: Object.freeze([{ fromNodeId: PLATFORM_LANE_NODE_IDS.capture, fromPort: 'transcript', toPort: 'in' }]),
          // A TEXT failure retains the last-good note and sets `textFailed` — it
          // has never failed the flush, and must not start to.
          onError: 'degrade',
          enabled: true,
          cadence: 'perTurn',
          branchGuards: Object.freeze([]),
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
  const onStart: RealtimeNode[] = [];
  // Which router/review nodes actually gate something on THIS lane — collected while the nodes
  // are built so the condition sweep below stays a lookup rather than a second graph walk.
  const guardedBy = new Set<string>();
  for (const stage of compiled.stages) {
    const nodes = (stage.nodes ?? [])
      .filter((node) => admitted.has(node.nodeId))
      .map<RealtimeNode>((node) => {
        // Guards are kept UNFILTERED, unlike `inputs`: the node they name is a durable router
        // this lane never executes, so filtering them to admitted producers would delete exactly
        // the decision the executor needs.
        const branchGuards = node.branchGuards ?? [];
        for (const guard of branchGuards) guardedBy.add(guard.fromNodeId);
        return {
          nodeId: node.nodeId,
          type: node.type,
          config: node.config ?? {},
          timeoutMs: toMs(node.timeoutSeconds, DEFAULT_TEXT_TIMEOUT_MS),
          maxAttempts: Math.max(1, node.retry?.maximumAttempts ?? 1),
          inputs: (node.inputs ?? []).filter((binding) => admitted.has(binding.fromNodeId)),
          onError: node.onError === 'fail' ? 'fail' : 'degrade',
          enabled: node.config?.enabled !== false,
          cadence: cadenceOf(node.config),
          branchGuards,
        };
      });
    // TASK-932 D-9 — PARTITION, in stage order, before the stages are renumbered. A warm-start
    // node left in the flush lane runs once per turn: a second LLM call against the live budget
    // and a second PRE_SUMMARY row per flush. Its bindings are kept as authored — the warm start
    // reads the trigger's context, which the executor resolves from the run context exactly as it
    // does for a node whose producer sits on the durable lane.
    onStart.push(...nodes.filter((node) => node.cadence === 'onStart'));
    const perTurn = nodes.filter((node) => node.cadence !== 'onStart');
    if (perTurn.length === 0) continue;
    stages.push({ stageIndex: stages.length, nodes: perTurn });
  }

  // A lane of NOTHING BUT warm-start nodes is still a lane: the tenant authored realtime work and
  // this runtime owns it. Returning `null` here would serve `PLATFORM_REALTIME_LANE` instead and
  // write a hardcoded note beside the graph's own — the substrate-exclusivity hazard, arriving
  // through a cadence.
  if (stages.length === 0 && onStart.length === 0) return null;

  return {
    source: 'tenant-graph',
    definitionSlug: compiled.slug ?? null,
    definitionVersionNumber: compiled.versionNumber ?? null,
    stages,
    onStart,
    guardrail: compiled.policyBindings?.guardrail?.enabled ?? null,
    conditions: conditionsFor(compiled, guardedBy),
  };
}

/**
 * The `core.condition` nodes named by a guard on this lane, in graph order.
 *
 * A guard may also name a `core.classify` (a model call) or a `core.humanReview` (a person) —
 * both `router`/`review` classes the compiler records guards for, and neither decidable from the
 * run context alone. Those are simply absent from this list, and the executor treats an
 * undecidable guard as "do not block", because refusing to document a consultation the lane
 * already documents today is the worse of the two errors.
 */
function conditionsFor(compiled: CompiledWorkflowConfig, guardedBy: ReadonlySet<string>): RealtimeCondition[] {
  const conditions: RealtimeCondition[] = [];
  for (const stage of compiled.stages) {
    for (const node of stage.nodes ?? []) {
      if (node.type !== 'core.condition' || !guardedBy.has(node.nodeId)) continue;
      conditions.push({ nodeId: node.nodeId, branches: conditionBranches(node.config) });
    }
  }
  return conditions;
}

/**
 * A `core.condition`'s authored branches, in order.
 *
 * As tolerant as `interpreter_core_condition` (`apps/harness/.../interpreter/nodes/core.py`) and
 * for the same reason: a malformed entry is SKIPPED rather than raising, so a branch nobody can
 * read cannot be the thing that stops a consultation being documented. The authoring schema
 * (`node-config-schemas.ts`, `required: ['key','when']`) is what refuses one at publish time.
 */
function conditionBranches(config: Readonly<Record<string, unknown>> | undefined): RealtimeConditionBranch[] {
  const branches = config?.branches;
  if (!Array.isArray(branches)) return [];
  const out: RealtimeConditionBranch[] = [];
  for (const branch of branches) {
    if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) continue;
    const { key, when } = branch as { key?: unknown; when?: unknown };
    if (typeof key === 'string' && key.length > 0 && typeof when === 'string' && when.length > 0) out.push({ key, when });
  }
  return out;
}

/** The authored `execution.cadence`, or `undefined`. A malformed `execution` reads as absent. */
function cadenceOf(config: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const execution = config?.execution;
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) return undefined;
  const cadence = (execution as { cadence?: unknown }).cadence;
  return typeof cadence === 'string' ? cadence : undefined;
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
 *
 * ## TASK-946 D2 — first-match was the wrong "first"
 *
 * Every seeded ArcaAI graph splits its per-turn summary by visit type and declares
 * `n_summary_new` BEFORE `n_summary_revisit` (`seed/28-workflow-library.ts`). First-match over
 * stage order therefore froze the new-visit shape on every consultation, including the revisits
 * whose own `n_summary_revisit` node then ran — the shape and the summariser disagreeing about
 * the same visit. Measured 2026-09-10: `requestedSlug: arcaai-bren-soap-new-visit` on a
 * consultation carrying a `parentConsultationId`.
 *
 * `branchHandles` is the lane's routing decision — {@link resolveBranchHandles}' output,
 * evaluated ONCE against the session's run context — and it narrows the walk to the nodes that
 * decision can actually reach. Omitting it keeps the previous first-match answer exactly, which
 * is the right answer for a caller that has no run context to offer and for every lane that
 * authors no split.
 *
 * REACHABLE means what `runRealtimeLane`'s own `branchSkip` means, and deliberately not
 * something adjacent: a node with no guards is always reachable; a guarded node is reachable
 * when one of its DECIDABLE guards names a handle that was taken. A guard whose producer this
 * lane cannot decide (a `core.classify` model call, a `core.humanReview` person) is left OUT of
 * the vote rather than counted against the node — refusing to name a shape is worse than naming
 * one, which is the same trade the executor makes.
 */
export function realtimeDocumentTemplateSlug(
  lane: RealtimeLane | null,
  branchHandles?: readonly { readonly nodeId: string; readonly handle: string }[],
): string | null {
  if (!lane) return null;
  const takenHandle = new Map((branchHandles ?? []).map((evaluation) => [evaluation.nodeId, evaluation.handle]));
  for (const stage of lane.stages) {
    for (const node of stage.nodes) {
      if (!isReachable(node, takenHandle)) continue;
      // TASK-893: with every realtime node a `core.agent`, the running-note node is the one that
      // NAMES a template — a node that names none is not it.
      const slug = node.config.documentTemplateSlug;
      if (typeof slug === 'string' && slug.trim().length > 0) return slug.trim();
    }
  }
  return null;
}

/** `runRealtimeLane`'s `branchSkip`, first rule, inverted — see {@link realtimeDocumentTemplateSlug}. */
function isReachable(node: RealtimeNode, takenHandle: ReadonlyMap<string, string>): boolean {
  // `?? []` because this is a never-throws read on the session-start path: a lane assembled by
  // something other than `buildRealtimeLane` (a positional fixture, a stored snapshot written
  // before guards existed) carries no `branchGuards`, and that means UNGUARDED, not a crash.
  const decidable = (node.branchGuards ?? []).filter((guard) => takenHandle.has(guard.fromNodeId));
  return decidable.length === 0 || decidable.some((guard) => takenHandle.get(guard.fromNodeId) === guard.handle);
}
