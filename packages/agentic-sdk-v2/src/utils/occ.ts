/**
 * @arcaai/vox - Optimistic-concurrency helpers (TASK-709)
 *
 * The note-content write routes (`PATCH :id/context/:contextId`,
 * `PATCH :id/summary/:summaryId`, `POST :id/summary/:contextItemId/approve`)
 * are `@RequiresIfMatch()`: a request without `If-Match` gets
 * `428 Precondition Required`, and a stale validator gets
 * `412 Precondition Failed`.
 *
 * These helpers keep the three (five, counting the `useArca` god-hook
 * duplicates) call sites consistent with the house pattern already used by
 * `useGlobalSettings.update`.
 */

import { AgenticError } from '../types/common';
import { ConfigConflictError } from '../types/settings';

/** Render a row version as an RFC 7232 strong validator (`7` → `"7"`). */
export function ifMatchFor(version: number): string {
  return `"${version}"`;
}

/**
 * Resolve the version to compare-and-set against, or throw a message that
 * tells the caller how to get one.
 *
 * There is no single-resource GET for context items or summaries, so the
 * version comes from the list/create response the SDK already holds in the
 * store — or explicitly from the caller.
 */
export function requireExpectedVersion(resourceId: string, explicit: number | undefined, known: number | undefined): number {
  const version = explicit ?? known;
  if (typeof version !== 'number') {
    throw new Error(
      `No known row version for ${resourceId}. Load the item first (so the SDK holds its \`version\`), ` +
        `or pass \`expectedVersion\` explicitly — the server requires an If-Match validator on this route.`,
    );
  }
  return version;
}

/**
 * Find the row version the SDK holds for a summary. The update route is keyed
 * by the summary's context-item id, so match either identifier.
 */
export function findSummaryVersion(
  summaries: ReadonlyArray<{ id: string; contextItemId?: string; version?: number }>,
  id: string,
): number | undefined {
  return summaries.find((s) => s.id === id || s.contextItemId === id)?.version;
}

/**
 * Map a `412 Precondition Failed` into a structured `ConfigConflictError`
 * so callers can `instanceof`-check and show a conflict/refresh affordance
 * instead of a generic failure. Any other error is returned unchanged.
 */
export function toOccError(error: unknown, resourceId: string, expectedVersion: number): unknown {
  if (error instanceof AgenticError) {
    const context = error.context as Record<string, unknown> | undefined;
    if (context?.status === 412) {
      const currentVersion = context.currentVersion;
      return new ConfigConflictError(resourceId, expectedVersion, typeof currentVersion === 'number' ? currentVersion : expectedVersion + 1);
    }
  }
  return error;
}
