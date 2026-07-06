/**
 * Cross-domain resource types mirroring the gateway's response envelope
 * (BaseResponse in @arcaai/applications — the console cannot import that
 * server package, so the wire shape is declared here once).
 */

export type ResourceStatus = 'ENABLED' | 'DISABLED' | 'SUSPENDED' | 'ARCHIVED' | 'DELETED';

/** Standard offset-pagination list query (PaginatedQuery on the gateway). */
export interface ListParams {
    /** One-based page number (gateway contract: `skip = (page - 1) * limit`). */
    page?: number;
    limit?: number;
    search?: string;
    /** Comma-separated fields the search applies to (e.g. "name,key"). */
    searchFields?: string;
    /** Comma-separated field:value pairs (e.g. "resourceStatus:ENABLED"). */
    filters?: string;
    /** Comma-separated field:direction pairs (e.g. "createdAt:desc"). */
    sort?: string;
    /** Endpoint-specific extras (keeps ListParams assignable to QueryParams). */
    [key: string]: string | number | boolean | undefined | null;
}

/** Fields every gateway resource response carries (timestamps are ISO strings). */
export interface BaseResource {
    id: string;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
    resourceStatus: ResourceStatus | null;
    resourceStatusUpdatedAt: string | null;
    resourceStatusUpdatedBy: string | null;
    createdBy: string | null;
    updatedBy: string | null;
}

/** A resource under optimistic concurrency: PATCH needs If-Match + expectedVersion. */
export interface VersionedResource extends BaseResource {
    version: number;
}
