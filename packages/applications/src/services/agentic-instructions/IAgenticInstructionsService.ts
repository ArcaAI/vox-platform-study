import { AgenticInstructionsResponse } from './dto';

/** Optional narrowing for the resolved prompt tier (defaults to the tenant baseline). */
export interface AgenticInstructionsResolveOptions {
  /** Resolve the prompt tier against a specific department (null/omitted = tenant baseline). */
  departmentId?: string;
  /** Prompt type to resolve the tier for (defaults to `new-patient`). */
  promptType?: 'pre-summary' | 'new-patient' | 'revisit';
}

/**
 * (Phase 3A) item 6 — read-only aggregator for the effective agentic
 * instruction set per tenant. Composes the harness policy (thresholds + safety),
 * the prompt-resolution cascade (tier), and the vendored PDSQI judge-prompt pin.
 */
export interface IAgenticInstructionsService {
  /** The effective instruction set for `tenantId` (404-over-403 cross-tenant is enforced by the controller). */
  getEffectiveInstructions(tenantId: string, options?: AgenticInstructionsResolveOptions): Promise<AgenticInstructionsResponse>;
}

export const IAgenticInstructionsService = Symbol('IAgenticInstructionsService');
