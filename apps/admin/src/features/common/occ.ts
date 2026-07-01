/**
 * Optimistic-concurrency conflict reducer (PHASE-2 §4b.2). Every mutation echoes
 * the read `version` as `expectedVersion`/`If-Match`; the server answers `409`
 * (or `412 Precondition Failed`) when the row drifted. The UI reaction is
 * uniform: tell the user it changed, refetch the latest, and let them re-apply.
 */

const OCC_CONFLICT_STATUSES = new Set([409, 412]);

const OCC_CONFLICT_MESSAGE = 'This changed since you loaded it. We refreshed the latest values — review and try again.';

/** Pull an HTTP status off an error-like object (top-level `status`/`statusCode`). */
function readStatus(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
    return undefined;
}

/**
 * True when an error is an OCC conflict (HTTP 409 or 412). Handles both the
 * plain `{ status }`/`{ statusCode }` shapes AND the SDK's `AgenticError`, which
 * nests the HTTP status under `context` (`{ context: { status: 409 } }`).
 */
export function isOccConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const status = readStatus(error) ?? readStatus((error as { context?: unknown }).context);
    return status !== undefined && OCC_CONFLICT_STATUSES.has(status);
}

export interface OccResolution {
    conflict: boolean;
    /** Present only on conflict — the refetch-and-retry guidance to surface. */
    message?: string;
}

export function reduceOccConflict(error: unknown): OccResolution {
    return isOccConflict(error) ? { conflict: true, message: OCC_CONFLICT_MESSAGE } : { conflict: false };
}
