import { GatewayError } from '@/shared/api';
import type { ContextSchemaUsagesResponse } from '../api/types';

/**
 * `POST :id/publish` (`consultation-context-schema.service.ts#publish`)
 * refuses a 400 in three shapes, each carrying its reasons as structured data
 * alongside `message` — surface those, not the generic message, so an admin
 * sees WHY a publish was refused.
 *
 * The three are independent gates, not degrees of the same one: a definition
 * can be structurally invalid, or valid but breaking for CLIENTS, or valid and
 * non-breaking yet refused by a CONSUMER that froze an older version.
 */
export interface PublishRejection {
  /** Structural problems (`contextSchemaDefinitionProblems`) — e.g. an unknown primitive. */
  problems?: string[];
  /** Breaking-change diffs — present only when the publish needs `allowBreakingChange`. */
  breakingChanges?: string[];
  /** Who would refuse this version — present on a `SCHEMA_IMPACT_UNACKNOWLEDGED` refusal. */
  impact?: ContextSchemaUsagesResponse;
  /** True only for `code: 'SCHEMA_IMPACT_UNACKNOWLEDGED'` — the publish needs `acknowledgeImpact`. */
  impactUnacknowledged: boolean;
}

export function publishRejection(error: unknown): PublishRejection | null {
  if (!(error instanceof GatewayError) || error.status !== 400) return null;
  const details = error.details as { problems?: unknown; breakingChanges?: unknown; code?: unknown; impact?: unknown } | undefined;
  const problems = Array.isArray(details?.problems) ? (details.problems as string[]) : undefined;
  const breakingChanges = Array.isArray(details?.breakingChanges) ? (details.breakingChanges as string[]) : undefined;
  const impact = details?.impact && typeof details.impact === 'object' ? (details.impact as ContextSchemaUsagesResponse) : undefined;
  if (!problems && !breakingChanges && !impact) return null;
  return { problems, breakingChanges, impact, impactUnacknowledged: details?.code === 'SCHEMA_IMPACT_UNACKNOWLEDGED' };
}
