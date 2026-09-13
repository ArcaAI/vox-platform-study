import type { UsageTrigger } from '../../usageLedger/usage-attributes';

/**
 * One Temporal activity execution's compute, as `hope-harness-worker` measured
 * it (TASK-959 §3.4).
 *
 * ============================================================================
 * WHY THIS IS NOT A TRAJECTORY STEP
 * ============================================================================
 * A trajectory step is the INFERENCE a node performed — an LLM call's 20
 * seconds are 20 seconds of waiting on the text service, not worker CPU. This
 * is the durable-function server's own occupancy: the orchestration, the node
 * activities, the sensors and the claim-check I/O that the worker burned on
 * behalf of one run. They are different money (capability `WORKFLOW`, provider
 * `harness`) and they arrive on the same POST only because the worker already
 * had a channel to the gateway.
 *
 * `cpuMs` is a FAIR SHARE, not an exact clock: concurrent activities share one
 * event-loop thread, so the interceptor apportions each thread-CPU delta across
 * the activities in flight. It is exact when one activity runs alone and it
 * always sums to the thread's true CPU (owner decision D-5).
 *
 * FLOATS, NOT INTEGERS. A fast activity burns well under a millisecond, so an
 * integer field would round the majority of this worker's samples to zero.
 *
 * `attempt` is what separates a Temporal REDELIVERY of one execution (same
 * attempt, same ledger key, deduped) from a real RETRY (attempt + 1 — a second
 * execution that really burned CPU).
 */
export interface ComputeSampleInput {
  tenantId: string;
  /** The Temporal `workflow_id`. */
  sessionId: string;
  /** The Temporal `workflow_run_id`. */
  runId: string;
  activityId: string;
  attempt: number;
  /** The Temporal activity name, e.g. `core.agent`. Open set — shape-checked, not enumerated. */
  activityType: string;
  /** Fair-shared thread CPU for this execution, in milliseconds. */
  cpuMs: number;
  /** Exact wall clock for this execution, in milliseconds. Carried for reconciliation, not billed. */
  wallMs: number;
  /**
   * OD-E's closed activity vocabulary, when the activity's input carried one.
   * Absent in practice today — no activity input declares a `trigger` field —
   * and stated as optional rather than defaulted, because a guessed trigger is
   * worse than none.
   */
  trigger?: UsageTrigger;
  // ── TASK-957 F-8 ──────────────────────────────────────────────────────────
  // The same node + clinician identity the trajectory steps carry, for the
  // worker-CPU rows. Declared HERE and on the gateway DTO ahead of a sender:
  // the ingest runs under `forbidNonWhitelisted`, so an undeclared key 400s the
  // WHOLE flush — which means the accepting side must land first, not second.
  // The harness half reads them off the activity input in
  // `temporal/compute_metering.py`, which is not this lane's file.
  /** The interpreter node whose activity burned this CPU. */
  nodeId?: string;
  /** The published definition version that node belongs to. */
  workflowVersionId?: string;
  /** The clinician the run acts for. */
  doctorId?: string;
}
