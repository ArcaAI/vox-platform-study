export const ILoopContextTextService = Symbol('ILoopContextTextService');

export interface ILoopContextTextService {
  /**
   * The extracted plain text of one context item, or `null` when there is none.
   *
   * Backs the loop's `document.extract_text` action. Never throws:
   * a missing, cross-tenant or not-yet-extracted item all resolve to `null`,
   * which simply ends that branch of the derived-context cascade.
   */
  resolveExtractedText(tenantId: string, consultationId: string, contextItemId: string): Promise<string | null>;
}
