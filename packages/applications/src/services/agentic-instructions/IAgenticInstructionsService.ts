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
   * (`'new-visit'` / `'revisit'`, or any alias — the retired `'new-patient'`
   * spelling still resolves). Kept a string rather than a closed union so the
   * wire contract survived the visit-type vocabulary's move to platform data
   * (TASK-882).
   *
   * Omitted ⇒ the initial-visit type, `'new-visit'`.
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
