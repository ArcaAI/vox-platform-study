/**
 * PHI redaction seam — shared by the gate-edit mining store and the other
 * redaction hops wired in (NER pre-processing, the DNA corpus).
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
   *    stable per-label, per-distinct-value tokens (`[PERSON_1]`, `[EMAIL_1]`,
   *    ...). Use where the consuming pipeline needs clinical entities intact
   *    (e.g. NLP/NER).
   *  - `'full'` — every flagged span is blanket-masked (`[REDACTED]`), no
   *    label leaks. Use for retained / derived / cross-patient artifacts (the
   *    gate-edit exemplar bank, the DNA writing-style corpus).
   *
   * Mechanism CONFIRMED ( Decision #12) against `apps/nlp`'s actual
   * entity-linking behavior — see `redact.py`'s module docstring for the full
   * rationale: clinical-term preservation is structural (GLiNER's PII taxonomy
   * never covers clinical entities, in either mode); stable per-entity tokens
   * are kept for `pseudonymize` because they avoid feeding the downstream NER
   * transformer a degenerate repeated-mask pattern, not because the ontology
   * linker needs coreference (it is a stateless per-span lookup and does not).
   */
  redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string>;
}

export const IPhiRedactor = Symbol('IPhiRedactor');
