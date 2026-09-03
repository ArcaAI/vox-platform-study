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
import { portPrimitiveSatisfies, type WorkflowPortDescriptor, type WorkflowPortPrimitive } from '@arcaai/workflow-contract';
import type { RealtimeLane, RealtimeNode } from './realtime-lane';
import { realtimeHandlerFor, type RealtimeCapabilities, type RealtimeNodeHandler } from './realtime-node-registry';

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

export interface RealtimeNodeOutcome {
  readonly nodeId: string;
  readonly type: string;
  readonly stageIndex: number;
  readonly status: RealtimeNodeStatus;
  readonly durationMs: number;
  readonly attempts: number;
  /** Present only on `succeeded`. Keyed by the node's declared `outputKey`s. */
  readonly output?: Record<string, unknown>;
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

export interface RealtimeRunResult {
  /** Outcomes in EXECUTION order: stage ascending, then as authored within a stage. */
  readonly outcomes: readonly RealtimeNodeOutcome[];
  /** Successful node outputs, keyed by node id. */
  readonly outputs: ReadonlyMap<string, Record<string, unknown>>;
  readonly events: readonly RealtimeDegradeEvent[];
  /** True when an `onError: 'fail'` node failed and the lane stopped. */
  readonly failed: boolean;
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

  // Index every node's handler FIRST, across all stages, so a binding can be
  // checked against its producer's contract even when that producer skipped or
  // degraded. Type safety must not depend on execution succeeding.
  for (const stage of lane.stages) {
    for (const node of stage.nodes) {
      const handler = realtimeHandlerFor(node.type);
      if (handler) producerHandlers.set(node.nodeId, handler);
    }
  }

  for (const stage of lane.stages) {
    if (failed) break;

    const stageResults = await Promise.all(
      stage.nodes.map(async (node): Promise<RealtimeNodeOutcome> => {
        const startedAt = Date.now();
        const handler = realtimeHandlerFor(node.type);

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

        // Resolve bindings BEFORE the enabled check: a disabled node must not be
        // able to hide a contract violation from publish-time review.
        const bound = resolveBoundInputs(node, handler, producerHandlers, outputs);

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
            const output = await withTimeout(
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

  return { outcomes, outputs, events, failed };
}
