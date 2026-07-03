import type { StatusColorRole } from '@arcaai/ui/components/shared';
import type { PageRequest } from '@arcaai/ui/lib/shared';
import type { User, UserListQuery } from '@arcaai/vox';

/**
 * Build the SDK `UserListQuery` from the grid pagination request plus the
 * `toPaginatedQuery(DataQueryState)` serialization (TASK-374 / TASK-375).
 *
 * The Users screen wires `DataQueryState → toPaginatedQuery → toUserListQuery →
 * useUsers().listPaginated`:
 *  - `page`/`limit` are numbers (the SDK forwards them via `appendPagination`).
 *  - `sort` (`field:asc|desc`), `filters` (`field:value`) and `search` are the
 *    backend `PaginatedQuery` CSV server-side params.
 *
 * If the backend ignores the server-side params it still returns the page, so
 * the grid degrades gracefully to the prior offset-only behavior.
 *
 * DEFECT-P1 — the grid's `OffsetPageRequest.page` is 0-based, but the backend
 * `PaginatedQuery` is 1-based (`formatFindAllProps`: `skip = max(0, (page - 1)
 * * limit)`). Forwarded verbatim, grid page 0 and page 1 both clamp to skip=0
 * and return identical rows. Translate 0-based → 1-based here (the single,
 * Users-only offset path: Tenants is client-mode, Audit is cursor-based), so
 * each grid page maps to a distinct backend offset. The grid is fully
 * controlled by its own 0-based `queryState`/`rowCount`, so the 1-based `page`
 * the backend echoes back is not consumed and never desyncs the displayed page.
 */
export function toUserListQuery(pagination: PageRequest, serialized: Record<string, string>): UserListQuery {
  const query: UserListQuery = { limit: pagination.limit };
  if (pagination.mode === 'offset') query.page = pagination.page + 1;
  if (serialized.search) query.search = serialized.search;
  if (serialized.sort) query.sort = serialized.sort;
  if (serialized.filters) query.filters = serialized.filters;
  return query;
}

// ── 20u grid status + facets (PHASE-3 §3) ──────────────────────────────────
// The Users surface renders the design status vocabulary (Active/Inactive/…)
// over the REAL `resourceStatus` enum (ENABLED/DISABLED/ARCHIVED). "Invited" is
// surfaced ONLY when the backend explicitly sends it — never fabricated from a
// missing last-login (which would mislabel real active users).

export interface UserStatusPresentation {
  label: string;
  colorRole: StatusColorRole;
}

const USER_STATUS_PRESENTATION: Record<string, UserStatusPresentation> = {
  ENABLED: { label: 'Active', colorRole: 'success' },
  DISABLED: { label: 'Inactive', colorRole: 'warning' },
  ARCHIVED: { label: 'Archived', colorRole: 'neutral' },
  INVITED: { label: 'Invited', colorRole: 'info' },
  PENDING: { label: 'Invited', colorRole: 'info' },
};

/** Map a user's `resourceStatus` to the 20u dot+label presentation. */
export function deriveUserStatus(user: Pick<User, 'resourceStatus'>): UserStatusPresentation {
  const raw = String(user.resourceStatus ?? '').toUpperCase();
  return USER_STATUS_PRESENTATION[raw] ?? { label: 'Unknown', colorRole: 'neutral' };
}

export interface FacetOption {
  label: string;
  value: string;
}

/** `+ Status` facet — labels are the design vocabulary, values the REAL enum filtered server-side. */
export const USER_STATUS_FACET_OPTIONS: FacetOption[] = [
  { label: 'Active', value: 'ENABLED' },
  { label: 'Inactive', value: 'DISABLED' },
  { label: 'Archived', value: 'ARCHIVED' },
];

/** `+ Type` facet — maps to the `isServiceAccount` boolean (serialized as a string for the CSV filter). */
export const USER_TYPE_FACET_OPTIONS: FacetOption[] = [
  { label: 'Human', value: 'false' },
  { label: 'Service account', value: 'true' },
];

export function userTypeLabel(isServiceAccount?: boolean): string {
  return isServiceAccount ? 'Service account' : 'Human';
}
