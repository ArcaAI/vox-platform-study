/**
 * PHI redaction seam — shared by the gate-edit mining store and the other
 * redaction hops wired in TASK-710 (NER pre-processing, the DNA corpus).
 *
 * Deliberately a narrow port rather than a direct dependency on the guardrail
 * client: every consumer's contract is "redacted text or nothing", and none
 * must be able to reach past it to a raw-text API by accident.
 *
 * Implementations MUST be conservative — returning the input unchanged is
 * treated by `GateEditMiningService` as a redaction FAILURE (the candidate is
 * dropped), so a stub that no-ops cannot silently become a PHI leak.
 */
export interface IPhiRedactor {
  /**
   * Return `text` with PHI removed/masked. Throwing, returning empty, or
   * returning the input unchanged all cause the caller to drop/abort.
   *
   * `mode` selects the redaction strategy (mirrors the guardrail
   * `POST /api/guardrail/redact` request contract):
   *  - `'pseudonymize'` — clinical entities (medication/condition names, never
   *    a GLiNER PII label) survive verbatim; identifiers are masked with
   *    stable per-label tokens. Use where the consuming pipeline needs
   *    clinical entities intact (e.g. NLP/NER).
   *  - `'full'` — every flagged span is blanket-masked, no label leaks. Use
   *    for retained / derived / cross-patient artifacts (the gate-edit
   *    exemplar bank, the DNA writing-style corpus).
   */
  redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string>;
}

export const IPhiRedactor = Symbol('IPhiRedactor');
