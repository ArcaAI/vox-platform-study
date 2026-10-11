/**
 * Read seam for the gate-edit learning loop.
 *
 * A narrow port for the same reason as {@link IPhiRedactor}: the consumer is
 * `PromptAssemblyService`, which must be able to enrich a prompt without taking
 * a dependency on the mining implementation — and, critically, a deployment
 * with nothing wired must produce today's zero-shot prompt rather than fail a
 * generation. The learning loop is an enhancement; it is never a prerequisite.
 */
export interface GateEditExemplarForPrompt {
  /**
   * The signed note's STRUCTURE only (TASK-1061 OD-2): headings, order and line shape, every value a
   * typed placeholder. The only field a prompt may ever show. Since TASK-1062 D-3 its value is the
   * stored `GateEditExemplar.structureAfter` column — never derived from `redactedAfter` at read.
   */
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
