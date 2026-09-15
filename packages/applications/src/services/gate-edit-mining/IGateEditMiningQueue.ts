/**
 * Enqueue seam for the gate-edit learning loop.
 *
 * A PORT, not the BullMQ queue itself, for one reason: the caller is the
 * clinician sign-off path. It must be able to hand off the signal without
 * importing queue infrastructure, and — more importantly — a deployment with no
 * implementation wired must simply not mine, rather than fail a sign-off.
 */
export interface GateEditMiningJob {
  tenantId: string;
  consultationId: string;
  contextItemId?: string | null;
  /**
   * TASK-972 Lane 2 — the clinician the training-capture gate is resolved for. Optional because
   * a job queued before this field existed carries none; the processor then falls back to the
   * consultation's own `doctorId`, so an older job is gated identically rather than ungated.
   */
  doctorId?: string | null;
  gateDecision: string;
  signedAt?: string | null;
}

export interface IGateEditMiningQueue {
  /**
   * Queue one encounter for mining. Implementations MUST return quickly and MUST
   * NOT do the mining inline — the caller has just committed a clinical
   * system-of-record write and is not a place to spend time or risk a throw.
   */
  enqueue(job: GateEditMiningJob): Promise<void>;
}

export const IGateEditMiningQueue = Symbol('IGateEditMiningQueue');
