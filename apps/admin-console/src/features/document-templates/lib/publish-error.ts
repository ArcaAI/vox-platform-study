import { GatewayError } from '@/shared/api';

/**
 * `POST :id/publish` (`document-template.service.ts#publish`) refuses a 400 in
 * two shapes, both carrying their reasons as structured arrays alongside
 * `message`. Surface those, not the generic message: an admin editing a
 * ten-section discharge summary should see every fault at once, which is
 * exactly why the server validator returns them all rather than throwing on
 * the first.
 *
 * Deliberately a local copy rather than an import from
 * `features/context-schemas` — features never import each other (rule 13
 * §Structure). The two surfaces answer to two different services that merely
 * happen to share a rejection convention; coupling them would make a change to
 * one silently redefine the other.
 */
export interface PublishRejection {
  /** Structural problems (`documentTemplateShapeProblems`) — e.g. an unknown form, a duplicate key. */
  problems?: string[];
  /** Breaking-change diffs — present only when the publish needs `allowBreakingChange`. */
  breakingChanges?: string[];
}

export function publishRejection(error: unknown): PublishRejection | null {
  if (!(error instanceof GatewayError) || error.status !== 400) return null;
  const details = error.details as { problems?: unknown; breakingChanges?: unknown } | undefined;
  const problems = Array.isArray(details?.problems) ? (details.problems as string[]) : undefined;
  const breakingChanges = Array.isArray(details?.breakingChanges) ? (details.breakingChanges as string[]) : undefined;
  if (!problems && !breakingChanges) return null;
  return { problems, breakingChanges };
}
