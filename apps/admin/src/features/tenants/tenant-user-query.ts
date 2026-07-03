import type { UserListQuery } from '@arcaai/vox';

/**
 * Build the SDK `UserListQuery` for the tenant-detail **members** grid (TASK-379).
 * The grid is simpler than the platform Users screen (search + status only), so
 * this composes the query directly rather than via `toPaginatedQuery`.
 *
 * Tenant scoping is carried by the SDK's `X-Tenant-Id` header (the working tenant),
 * not by a query param. DEFECT-P1: the grid page is 0-based but the backend
 * `PaginatedQuery` is 1-based, so translate `page + 1` here.
 */
export interface TenantMemberQueryState {
  /** 0-based grid page. */
  page: number;
  limit: number;
  search?: string;
  /** `resourceStatus` facet value (e.g. `ENABLED`). */
  status?: string;
}

export function buildTenantUserListQuery(state: TenantMemberQueryState): UserListQuery {
  const query: UserListQuery = { page: state.page + 1, limit: state.limit };
  const search = state.search?.trim();
  if (search) query.search = search;
  if (state.status) query.filters = `resourceStatus:${state.status}`;
  return query;
}
