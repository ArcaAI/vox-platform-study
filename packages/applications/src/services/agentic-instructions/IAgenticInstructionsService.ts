import type { PromptTypeSelector } from '../consultation/prompt/prompt-resolution.service';
import { AgenticInstructionsResponse } from './dto';

/** Optional narrowing for the resolved prompt tier (defaults to the tenant baseline). */
export interface AgenticInstructionsResolveOptions {
  /** Resolve the prompt tier against a specific department (null/omitted = tenant baseline). */
  departmentId?: string;
  /**
   * Prompt type to resolve the tier for.
   *
   * Either a PHASE selector (`'pre-summary'`, `'live'`) or a VISIT-TYPE KEY
   * from the tenant's `consultation.visitTypes` catalogue. It stopped being a
   * closed union at TASK-815 §11 row 3: an admin must be able to ask this
   * surface about a visit type its own tenant defined, and a three-value enum
   * could only ever answer for the platform's two.
   *
   * Omitted ⇒ the tenant's own initial-visit type, resolved from that catalogue
   * (the two shipped defaults make that `'new-visit'`; the retired `'new-patient'`
   * spelling is an alias on that same entry, so a caller that sends it still
   * resolves here).
   */
  promptType?: PromptTypeSelector;
}

/**
 * Read-only aggregator for the effective agentic
 * instruction set per tenant. Composes the harness policy (thresholds + safety),
 * the prompt-resolution cascade (tier), and the vendored PDSQI judge-prompt pin.
 */
export interface IAgenticInstructionsService {
  /** The effective instruction set for `tenantId` (404-over-403 cross-tenant is enforced by the controller). */
  getEffectiveInstructions(tenantId: string, options?: AgenticInstructionsResolveOptions): Promise<AgenticInstructionsResponse>;
}

export const IAgenticInstructionsService = Symbol('IAgenticInstructionsService');
