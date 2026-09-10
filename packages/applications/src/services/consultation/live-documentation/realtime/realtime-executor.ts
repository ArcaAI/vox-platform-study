/**
 * the REALTIME GRAPH EXECUTOR.
 *
 * Walks a {@link RealtimeLane} stage by stage. Within a stage every node runs
 * CONCURRENTLY: stage members fan out from the same upstream with no
 * mutual dependency, so wall-clock is the slowest call and not the sum, and a
 * discharge summary timing out leaves the SOAP note untouched.
 *
 * Four properties this file exists to guarantee:
 *
 *  1. **Inputs resolve by DECLARED PORT** — never by an expression the caller
 *     happened to have in scope. It mirrors the harness interpreter's
 *     `_resolve_bound_inputs` exactly, including its three distinct outcomes.
 *  2. **NER can never receive generated text.** Enforced by the port-type check
 *     in `resolveBoundInputs`, not by convention. `document` and `transcript` are
 *     siblings under `text`, so `document -> transcript` is a type error.
 *  3. **Budget, retry and staleness are PER NODE**, not per flush. A late
 *     response never overwrites fresher content: it is discarded as `stale`.
 *  4. **Degrade is never silent.** Every skip, degrade, timeout and failure
 *     produces a typed event for the clinician UI. Silent degradation to an empty
 *     note is exactly why the 2026-08-25 outage went unnoticed for hours.
 */
import {
  evaluateCondition,
  portPrimitiveSatisfies,
  type ExpressionValue,
  type WorkflowPortDescriptor,
  type WorkflowPortPrimitive,
} from '@arcaai/workflow-contract';
import type { RealtimeLane, RealtimeNode } from './realtime-lane';
import { realtimeHandlerFor, type RealtimeCapabilities, type RealtimeCapabilityKey, type RealtimeNodeHandler } from './realtime-node-registry';

/**
 * A binding the graph declares but the node contract cannot support.
 *
 * NON-RETRYABLE and it ESCAPES the stage's all-settled join, exactly like the
 * harness interpreter's `unresolved_input_binding`: a contract violation is not a
 * node outcome, and flattening it into a per-node `degraded` would let a graph
 * that wires generated text into NER run quietly with NER simply "unavailable".
 */
export class RealtimeBindingError extends Error {
  constructor(
    message: string,
    readonly nodeId: string,
    readonly kind: 'unresolved-port' | 'incompatible-port',
  ) {
    super(message);
    this.name = 'RealtimeBindingError';
  }
}

export type RealtimeNodeStatus = 'succeeded' | 'degraded' | 'failed' | 'skipped' | 'timed-out' | 'stale';

/** The durable interpreter's own reason code for a node the graph routed around (`_branch_skip`). */
const BRANCH_NOT_TAKEN = 'branch_not_taken';

export interface RealtimeNodeOutcome {
  readonly nodeId: string;
  readonly type: string;
  readonly stageIndex: number;
  readonly status: RealtimeNodeStatus;
  readonly durationMs: number;
  readonly attempts: number;
  /** Present only on `succeeded`. Keyed by the node's declared `outputKey`s. */
  readonly output?: Record<string, unknown>;
  /** Present only on `succeeded`: the CAPABILITY the node ran (TASK-893 — what a projection keys on). */
  readonly capability?: RealtimeCapabilityKey;
  /** PHI-safe: an error name or a short reason code. Never clinical text. */
  readonly reason?: string;
}

/**
 * A typed degrade event. EVERY non-success outcome emits one — that is the
 * "degrade is never silent" rule, expressed as a return value rather than a log
 * line, so the caller cannot forget to surface it.
 */
export interface RealtimeDegradeEvent {
  readonly nodeId: string;
  readonly type: string;
  readonly status: Exclude<RealtimeNodeStatus, 'succeeded'>;
  readonly reason: string;
  readonly laneSource: RealtimeLane['source'];
}

/**
 * What ONE `core.condition` decided for this run — the realtime mirror of the durable activity's
 * `{"evaluation": {"branch", "matched", "errors"}}` output.
 *
 * Returned rather than logged, exactly like {@link RealtimeDegradeEvent}: "the else branch was
 * chosen because every expression errored" and "the else branch was chosen because no branch
 * matched" produce the same note, so the caller must be able to tell them apart.
 */
export interface RealtimeBranchEvaluation {
  readonly nodeId: string;
  /** The handle taken: the FIRST branch whose expression evaluated `true`, else `else`. */
  readonly handle: string;
  readonly matched: boolean;
  /** PHI-safe: a branch key and an evaluator message. Never clinical text. */
  readonly errors: readonly { readonly branch: string; readonly error: string }[];
}

export interface RealtimeRunResult {
  /** Outcomes in EXECUTION order: stage ascending, then as authored within a stage. */
  readonly outcomes: readonly RealtimeNodeOutcome[];
  /** Successful node outputs, keyed by node id. */
  readonly outputs: ReadonlyMap<string, Record<string, unknown>>;
  readonly events: readonly RealtimeDegradeEvent[];
  /** True when an `onError: 'fail'` node failed and the lane stopped. */
  readonly failed: boolean;
  /** TASK-932 — what each of `lane.conditions` decided, in lane order. Empty for an unbranched lane. */
  readonly branchEvaluations: readonly RealtimeBranchEvaluation[];
}

export interface RealtimeRunInput {
  readonly lane: RealtimeLane;
  readonly consultationId: string;
  readonly tenantId: string;
  readonly capabilities: RealtimeCapabilities;
  /**
   * Superseded-generation check. Consulted BEFORE a node starts and again when it
   * returns; a result that arrives after a newer flush claimed the session is
   * discarded as `stale` rather than allowed to overwrite fresher content.
   */
  readonly isStale?: () => boolean;
  /** Aborts in-flight work when a newer flush supersedes this one. */
  readonly signal?: AbortSignal;
  /**
   * TASK-932 — the run context `{ trigger, vars, nodes }` (TASK-864 §3.2) every
   * `core.condition` guard is evaluated against. On this lane `trigger` is the consultation's
   * trigger context, so a seeded visit-type split reads `trigger.context.visit_type`.
   *
   * ONE evaluation per flush, BEFORE stage 0, so the routing decision is identical for every
   * node of the walk and cannot change mid-flush. The consequence is stated rather than hidden:
   * `nodes.*` resolves against an EMPTY cache and `vars.*` against `{}` — this lane executes
   * neither the condition nor any `core.variable`, so a guard reading either falls to `else`
   * with a recorded error rather than being answered wrongly.
   *
   * Absent = an empty context, in which every expression errors and every condition takes
   * `else` — the same fall-through the durable activity performs on an unevaluable branch.
   */
  readonly runContext?: Record<string, ExpressionValue>;
}

function outputPort(handler: RealtimeNodeHandler, name: string): WorkflowPortDescriptor | undefined {
  return handler.outputs.find((port) => port.name === name);
}

function inputPort(handler: RealtimeNodeHandler, name: string): WorkflowPortDescriptor | undefined {
  return handler.inputs.find((port) => port.name === name);
}

/**
 * Resolve one node's declared bindings into `{ toPort: value }`.
 *
 * Three distinct outcomes, mirroring `_resolve_bound_inputs`
 * (`apps/harness/.../interpreter/workflow.py`) so the two runtimes cannot drift:
 *
 *  - a `control` socket (no `outputKey`) binds NOTHING — ordering only;
 *  - a declared key ABSENT from this run's output contributes nothing (a degraded
 *    predecessor stores no output). Never a throw, never a fabricated value;
 *  - a port the producer does not DECLARE raises. That is a contract violation,
 *    not a node outcome.
 *
 * And one thing the Python resolver does not do, because it has no port types on
 * its side of the parity fixture: it TYPE-CHECKS the edge. That check is the
 * anti-laundering rule.
 */
function resolveBoundInputs(
  node: RealtimeNode,
  handler: RealtimeNodeHandler,
  producerHandlers: ReadonlyMap<string, RealtimeNodeHandler>,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};

  for (const binding of node.inputs) {
    const producer = producerHandlers.get(binding.fromNodeId);
    const producedPort = producer ? outputPort(producer, binding.fromPort) : undefined;
    if (!producer || !producedPort) {
      throw new RealtimeBindingError(
        `unresolved input binding: node "${node.nodeId}" (${node.type}) binds "${binding.toPort}" from ` +
          `"${binding.fromNodeId}" port "${binding.fromPort}", which is not a declared output socket of that node type`,
        node.nodeId,
        'unresolved-port',
      );
    }

    const consumedPort = inputPort(handler, binding.toPort);
    if (!consumedPort) {
      throw new RealtimeBindingError(
        `unresolved input binding: node "${node.nodeId}" (${node.type}) declares no input socket "${binding.toPort}"`,
        node.nodeId,
        'unresolved-port',
      );
    }

    // A control edge carries ordering, not payload.
    if (producedPort.primitive === 'control' || consumedPort.primitive === 'control') continue;

    if (!portPrimitiveSatisfies(producedPort.primitive as WorkflowPortPrimitive, consumedPort.primitive as WorkflowPortPrimitive)) {
      throw new RealtimeBindingError(
        `incompatible input binding: "${binding.fromNodeId}.${binding.fromPort}" produces ` +
          `${producedPort.primitive} which does not satisfy "${node.nodeId}.${binding.toPort}" (${consumedPort.primitive})`,
        node.nodeId,
        'incompatible-port',
      );
    }

    const key = producedPort.outputKey;
    if (!key) continue;
    const upstream = outputs.get(binding.fromNodeId);
    if (!upstream || !(key in upstream)) continue; // degraded predecessor — contributes nothing
    bound[binding.toPort] = upstream[key];
  }

  return bound;
}

/**
 * Evaluate every condition the lane's guards name, in order: the FIRST branch whose expression
 * is `true` wins, otherwise `else`.
 *
 * Byte-for-byte the rule `interpreter_core_condition` applies
 * (`apps/harness/.../interpreter/nodes/core.py`), including its treatment of a broken
 * expression: the error is RECORDED and that branch counts as not taken, so a condition nobody
 * can evaluate falls through to `else` observably instead of routing on a guess. `evaluateCondition`
 * is the same evaluator both lanes call, so the two runtimes cannot drift on the language.
 *
 * TASK-946 D2 — EXPORTED, because the routing decision is needed once more OUTSIDE a flush:
 * `ensureTemplateResolved` freezes the note's SHAPE at session start and must freeze the shape
 * of the branch the session will actually take. Exporting the evaluator rather than
 * reimplementing the walk is what keeps the frozen template and the executed summary node from
 * disagreeing — which is exactly what they did on 2026-09-10, when a revisit was documented with
 * the new-visit shape while its own `n_summary_revisit` node ran.
 */
export function resolveBranchHandles(lane: RealtimeLane, runContext: Record<string, ExpressionValue>): RealtimeBranchEvaluation[] {
  return lane.conditions.map((condition) => {
    const errors: { branch: string; error: string }[] = [];
    let handle = 'else';
    for (const branch of condition.branches) {
      const { taken, error } = evaluateCondition(branch.when, runContext);
      if (error !== undefined) {
        errors.push({ branch: branch.key, error });
        continue;
      }
      if (taken) {
        handle = branch.key;
        break;
      }
    }
    return { nodeId: condition.nodeId, handle, matched: handle !== 'else', errors };
  });
}

/** Race the node against its OWN budget. Rejects with a `timeout` marker. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('node budget exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function degradeEvent(outcome: RealtimeNodeOutcome, laneSource: RealtimeLane['source']): RealtimeDegradeEvent | null {
  if (outcome.status === 'succeeded') return null;
  // TASK-932 — ROUTING IS NOT DEGRADATION. A node the graph deliberately routed around is the
  // condition working, and publishing `lane.degraded` for it once per flush would train the
  // clinician (and the operator reading the warnings) to ignore the channel that carries the
  // real failures. Every other skip — `disabled_by_config`, `unsupported_node_type` — still
  // emits, unchanged.
  if (outcome.status === 'skipped' && outcome.reason === BRANCH_NOT_TAKEN) return null;
  return {
    nodeId: outcome.nodeId,
    type: outcome.type,
    status: outcome.status,
    reason: outcome.reason ?? outcome.status,
    laneSource,
  };
}

/**
 * Walk the lane.
 *
 * Never rejects for a NODE failure — those become outcomes and events. It DOES
 * reject for a {@link RealtimeBindingError}, because a graph that cannot be
 * wired is not a graph that ran badly.
 */
export async function runRealtimeLane(input: RealtimeRunInput): Promise<RealtimeRunResult> {
  const { lane, capabilities, consultationId, tenantId, isStale, signal } = input;

  const outcomes: RealtimeNodeOutcome[] = [];
  const outputs = new Map<string, Record<string, unknown>>();
  const events: RealtimeDegradeEvent[] = [];
  const producerHandlers = new Map<string, RealtimeNodeHandler>();
  let failed = false;

  // ONCE, before stage 0 — see `RealtimeRunInput.runContext`.
  const branchEvaluations = resolveBranchHandles(lane, input.runContext ?? {});
  const takenHandle = new Map(branchEvaluations.map((evaluation) => [evaluation.nodeId, evaluation.handle]));
  const branchSkipped = new Set<string>();

  /**
   * Whether the graph routed AROUND this node — `_branch_skip`, transcribed.
   *
   * Two rules, in the durable order:
   *  1. a guarded node runs only when one of its guards' handles was taken. A guard naming a
   *     producer this lane cannot decide (a `core.classify` model call, a `core.humanReview`
   *     person — both `router`/`review` classes the compiler records guards for) is left OUT of
   *     the vote rather than counted as not-taken: blocking on a decision the durable lane owns
   *     would delete a note this lane produces today, which is the worse of the two errors;
   *  2. a node whose every predecessor was itself branch-skipped is skipped too, so a chain
   *     behind a closed branch reports `branch_not_taken` rather than a cascade of false
   *     degrades from inputs that will never arrive.
   */
  const branchSkip = (node: RealtimeNode): boolean => {
    const decidable = node.branchGuards.filter((guard) => takenHandle.has(guard.fromNodeId));
    if (decidable.length > 0 && !decidable.some((guard) => takenHandle.get(guard.fromNodeId) === guard.handle)) return true;
    const predecessors = new Set([...node.inputs.map((binding) => binding.fromNodeId), ...node.branchGuards.map((guard) => guard.fromNodeId)]);
    return predecessors.size > 0 && [...predecessors].every((nodeId) => branchSkipped.has(nodeId));
  };

  // Index every node's handler FIRST, across all stages, so a binding can be
  // checked against its producer's contract even when that producer skipped or
  // degraded. Type safety must not depend on execution succeeding.
  for (const stage of lane.stages) {
    for (const node of stage.nodes) {
      const handler = realtimeHandlerFor(node.type, node.config);
      if (handler) producerHandlers.set(node.nodeId, handler);
    }
  }

  for (const stage of lane.stages) {
    if (failed) break;

    const stageResults = await Promise.all(
      stage.nodes.map(async (node): Promise<RealtimeNodeOutcome> => {
        const startedAt = Date.now();
        const handler = realtimeHandlerFor(node.type, node.config);

        if (!handler) {
          return {
            nodeId: node.nodeId,
            type: node.type,
            stageIndex: stage.stageIndex,
            status: 'skipped',
            durationMs: 0,
            attempts: 0,
            reason: 'unsupported_node_type',
          };
        }

        // Resolve bindings BEFORE the enabled and branch checks: neither a disabled node nor
        // one the graph routed around may hide a contract violation from publish-time review.
        // (The durable interpreter orders its own branch check before the disabled check; the
        // ordering that matters clinically is that one, and it is preserved below.)
        const bound = resolveBoundInputs(node, handler, producerHandlers, outputs);

        if (branchSkip(node)) {
          branchSkipped.add(node.nodeId);
          return {
            nodeId: node.nodeId,
            type: node.type,
            stageIndex: stage.stageIndex,
            status: 'skipped',
            durationMs: 0,
            attempts: 0,
            reason: BRANCH_NOT_TAKEN,
          };
        }

        if (!node.enabled) {
          return {
            nodeId: node.nodeId,
            type: node.type,
            stageIndex: stage.stageIndex,
            status: 'skipped',
            durationMs: 0,
            attempts: 0,
            reason: 'disabled_by_config',
          };
        }

        if (isStale?.()) {
          return {
            nodeId: node.nodeId,
            type: node.type,
            stageIndex: stage.stageIndex,
            status: 'stale',
            durationMs: 0,
            attempts: 0,
            reason: 'superseded_before_start',
          };
        }

        let attempts = 0;
        let lastReason = 'unknown';
        while (attempts < node.maxAttempts) {
          attempts += 1;
          try {
            const { output, capability } = await withTimeout(
              handler.run({ bound, config: node.config, tenantId, consultationId, capabilities, signal }),
              node.timeoutMs,
            );

            // A result that lands after a newer flush claimed the session is
            // DISCARDED. Publishing it would overwrite fresher content with older
            // content — the exact failure DD-4 names.
            if (isStale?.()) {
              return {
                nodeId: node.nodeId,
                type: node.type,
                stageIndex: stage.stageIndex,
                status: 'stale',
                durationMs: Date.now() - startedAt,
                attempts,
                reason: 'superseded_after_completion',
              };
            }

            return {
              nodeId: node.nodeId,
              type: node.type,
              stageIndex: stage.stageIndex,
              status: 'succeeded',
              durationMs: Date.now() - startedAt,
              attempts,
              output,
              capability,
            };
          } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            if (lastReason === 'node budget exceeded') {
              return {
                nodeId: node.nodeId,
                type: node.type,
                stageIndex: stage.stageIndex,
                status: 'timed-out',
                durationMs: Date.now() - startedAt,
                attempts,
                reason: `budget_exceeded_${node.timeoutMs}ms`,
              };
            }
          }
        }

        return {
          nodeId: node.nodeId,
          type: node.type,
          stageIndex: stage.stageIndex,
          status: node.onError === 'fail' ? 'failed' : 'degraded',
          durationMs: Date.now() - startedAt,
          attempts,
          reason: lastReason,
        };
      }),
    );

    for (const outcome of stageResults) {
      outcomes.push(outcome);
      if (outcome.status === 'succeeded' && outcome.output) outputs.set(outcome.nodeId, outcome.output);
      const event = degradeEvent(outcome, lane.source);
      if (event) events.push(event);
      if (outcome.status === 'failed') failed = true;
    }
  }

  return { outcomes, outputs, events, failed, branchEvaluations };
}
