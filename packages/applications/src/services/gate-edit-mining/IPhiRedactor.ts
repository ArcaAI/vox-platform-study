/**
 * PHI redaction seam for the gate-edit mining store.
 *
 * Deliberately a narrow port rather than a direct dependency on the guardrail
 * client: the mining store's contract is "redacted text or nothing", and the
 * consumer must not be able to reach past it to a raw-text API by accident.
 *
 * Implementations MUST be conservative — returning the input unchanged is
 * treated by `GateEditMiningService` as a redaction FAILURE (the candidate is
 * dropped), so a stub that no-ops cannot silently become a PHI leak.
 */
export interface IPhiRedactor {
  /**
   * Return `text` with PHI removed/masked. Throwing, returning empty, or
   * returning the input unchanged all cause the candidate to be dropped.
   */
  redact(text: string): Promise<string>;
}

export const IPhiRedactor = Symbol('IPhiRedactor');
