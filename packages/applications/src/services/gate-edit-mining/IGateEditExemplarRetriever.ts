/**
 * Read seam for the gate-edit learning loop (TASK-533 B6, GAP-A1 consumption b).
 *
 * A narrow port for the same reason as {@link IPhiRedactor}: the consumer is
 * `PromptAssemblyService`, which must be able to enrich a prompt without taking
 * a dependency on the mining implementation — and, critically, a deployment
 * with nothing wired must produce today's zero-shot prompt rather than fail a
 * generation. The learning loop is an enhancement; it is never a prerequisite.
 */
export interface GateEditExemplarForPrompt {
  /** The PHI-redacted signed note. The only field a prompt may ever show. */
  redactedAfter?: string | null;
  qualitySignal?: string | null;
  tenantId?: string;
}

export interface IGateEditExemplarRetriever {
  /**
   * Top-K exemplars for the tenant (+ department when known), most useful first.
   * Implementations MUST return `[]` rather than throw on any failure.
   */
  retrieveExemplars(params: { tenantId: string; departmentId?: string | null; limit: number }): Promise<GateEditExemplarForPrompt[]>;
}

export const IGateEditExemplarRetriever = Symbol('IGateEditExemplarRetriever');
