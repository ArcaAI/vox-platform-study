import { GatewayError } from '@/shared/api';

/**
 * `POST :id/publish` (`consultation-context-schema.service.ts#publish`)
 * refuses a 400 in two shapes, both carrying the reasons as structured
 * arrays alongside `message` — surface those, not the generic message, so an
 * admin sees WHY a publish was refused ("publish validation
 * surfacing the server's actual rejection reasons").
 */
export interface PublishRejection {
  /** Structural problems (`contextSchemaDefinitionProblems`) — e.g. an unknown primitive. */
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
