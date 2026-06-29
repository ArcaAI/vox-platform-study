import { DbFilters, IFindAllProps } from '@arcaai/domains';

/**
 * TASK-373 — generic, opt-in cursor (keyset) pagination engine.
 *
 * This is the symmetric counterpart of the offset helpers in
 * `paginatedQueryParamConverters.ts`. It is transport-agnostic: it produces an
 * {@link IFindAllProps} that flows through the existing `Repository.findAll`
 * (so soft-delete + tenant `where` behave identically to the offset path) and
 * assembles the `{ data, nextCursor, hasMore }` page envelope the client
 * `PageResult` contract expects.
 *
 * Ordering is a stable keyset over `(<sortKey>, id)` — for our entities the
 * sort key is the indexed `createdAt` timestamp and `id` is a time-ordered
 * uuid v7 tiebreaker, giving a deterministic, monotonic cursor with no schema
 * change required.
 */

/** Default page size, aligned with the offset `DEFAULT_PAGE_SIZE` (10). */
export const DEFAULT_CURSOR_LIMIT = 10;
/** Hard cap on a single cursor page to protect the DB. */
export const MAX_CURSOR_LIMIT = 100;

/** Decoded cursor payload: the sort-key value (`k`) + the uuid tiebreaker (`id`). */
export interface CursorPayload {
  /** The sort-key value of the last row on the previous page (ISO string for timestamps). */
  k: string;
  /** The id of the last row on the previous page (tiebreaker). */
  id: string;
}

export type CursorDirection = 'asc' | 'desc';

export interface BuildCursorPropsOptions {
  /** Base where (tenant scope + filters) the keyset predicate is AND-ed with. */
  where?: DbFilters;
  /** Field the keyset orders by. Defaults to `createdAt`. */
  sortKey?: string;
  /** Sort direction. Defaults to `desc` (newest first). */
  direction?: CursorDirection;
}

/** The page envelope returned by {@link toCursorPage} — matches the client `PageResult`. */
export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/** Encode a cursor payload into an opaque base64url token. */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify({ k: payload.k, id: payload.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor token. Returns `null` for any malformed, tampered, or
 * wrong-shape token so callers can reject it as a `BadRequestException`.
 */
export function decodeCursor(token: string): CursorPayload | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).k === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      const { k, id } = parsed as CursorPayload;
      return { k, id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Clamp a requested limit into `[1, MAX_CURSOR_LIMIT]`, defaulting when absent/invalid. */
export function clampCursorLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_CURSOR_LIMIT;
  return Math.min(Math.floor(limit), MAX_CURSOR_LIMIT);
}

/**
 * Build the `IFindAllProps` for a keyset page: over-fetches `limit + 1` rows to
 * detect `hasMore`, orders by `(<sortKey>, id)`, and (when a cursor is present)
 * composes the keyset predicate with the caller's base `where` via `AND`.
 */
export function buildCursorFindAllProps(
  cursor: CursorPayload | null,
  limit: number,
  options: BuildCursorPropsOptions = {},
): IFindAllProps {
  const { where, sortKey = 'createdAt', direction = 'desc' } = options;
  const sort = [{ [sortKey]: direction }, { id: direction }];

  if (!cursor) {
    return { page: 1, limit: limit + 1, sort, where };
  }

  const op = direction === 'asc' ? 'gt' : 'lt';
  // Sort key is a timestamp for our entities; compare as Date so Prisma binds it correctly.
  const keyValue = new Date(cursor.k);
  const keyset: DbFilters = {
    OR: [
      { [sortKey]: { [op]: keyValue } },
      { AND: [{ [sortKey]: keyValue }, { id: { [op]: cursor.id } }] },
    ],
  };

  return {
    page: 1,
    limit: limit + 1,
    sort,
    where: where ? { AND: [where, keyset] } : keyset,
  };
}

/**
 * Assemble the page envelope from over-fetched rows: slices to `limit`, derives
 * `hasMore`, and (when there is a next page) encodes `nextCursor` from the last
 * returned row.
 */
export function toCursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  getSortKey: (row: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ k: getSortKey(last), id: last.id }) : null;
  return { data, nextCursor, hasMore, limit };
}
