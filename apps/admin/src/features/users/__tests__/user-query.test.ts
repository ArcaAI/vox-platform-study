import { describe, expect, it } from 'vitest';
import { deriveUserStatus, toUserListQuery, USER_STATUS_FACET_OPTIONS, USER_TYPE_FACET_OPTIONS, userTypeLabel } from '../user-query';

describe('toUserListQuery (Users server-side query wiring)', () => {
    // DEFECT-P1: the grid's `OffsetPageRequest.page` is 0-based (TanStack table
    // convention), but the backend `PaginatedQuery` is 1-based —
    // `formatFindAllProps` computes `skip = max(0, (page - 1) * limit)`. Sent
    // verbatim, grid page 0 and page 1 BOTH resolve to skip=0 and return the
    // same rows. The mapper translates the 0-based grid page → 1-based backend
    // page so each grid page maps to a distinct offset.
    it('translates the 0-based grid first page to the backend 1-based page', () => {
        expect(toUserListQuery({ mode: 'offset', page: 0, limit: 20 }, { page: '0', limit: '20' })).toEqual({
            page: 1,
            limit: 20,
        });
    });

    it('translates an arbitrary 0-based grid page (+1)', () => {
        expect(toUserListQuery({ mode: 'offset', page: 2, limit: 50 }, { page: '2', limit: '50' })).toEqual({
            page: 3,
            limit: 50,
        });
    });

    it('maps consecutive grid pages 0→1 to distinct backend pages 1→2', () => {
        const gridPage0 = toUserListQuery({ mode: 'offset', page: 0, limit: 20 }, { page: '0', limit: '20' });
        const gridPage1 = toUserListQuery({ mode: 'offset', page: 1, limit: 20 }, { page: '1', limit: '20' });
        expect(gridPage0.page).toBe(1);
        expect(gridPage1.page).toBe(2);
        expect(gridPage0.page).not.toBe(gridPage1.page);
    });

    it('forwards sort, filters and search server-side params from toPaginatedQuery', () => {
        const query = toUserListQuery(
            { mode: 'offset', page: 0, limit: 20 },
            { page: '0', limit: '20', sort: 'username:asc', filters: 'resourceStatus:ENABLED', search: 'ana' },
        );

        expect(query).toEqual({
            page: 1,
            limit: 20,
            sort: 'username:asc',
            filters: 'resourceStatus:ENABLED',
            search: 'ana',
        });
    });

    it('omits empty server-side params (graceful degradation to offset-only)', () => {
        const query = toUserListQuery({ mode: 'offset', page: 0, limit: 20 }, { page: '0', limit: '20' });

        expect(query).toEqual({ page: 1, limit: 20 });
        expect(query.sort).toBeUndefined();
        expect(query.filters).toBeUndefined();
        expect(query.search).toBeUndefined();
    });
});

describe('deriveUserStatus (20u dot+label status, design labels over the resourceStatus enum)', () => {
    it('maps the real resourceStatus enum to the design status label + semantic role', () => {
        expect(deriveUserStatus({ resourceStatus: 'ENABLED' })).toEqual({ label: 'Active', colorRole: 'success' });
        expect(deriveUserStatus({ resourceStatus: 'DISABLED' })).toEqual({ label: 'Inactive', colorRole: 'warning' });
        expect(deriveUserStatus({ resourceStatus: 'ARCHIVED' })).toEqual({ label: 'Archived', colorRole: 'neutral' });
    });

    it('surfaces an Invited status only when the backend signals it (never fabricated from a missing login)', () => {
        expect(deriveUserStatus({ resourceStatus: 'INVITED' })).toEqual({ label: 'Invited', colorRole: 'info' });
    });

    it('is case-insensitive and falls back to Unknown/neutral for absent/garbage status', () => {
        expect(deriveUserStatus({ resourceStatus: 'enabled' })).toEqual({ label: 'Active', colorRole: 'success' });
        expect(deriveUserStatus({})).toEqual({ label: 'Unknown', colorRole: 'neutral' });
        expect(deriveUserStatus({ resourceStatus: 'WAT' })).toEqual({ label: 'Unknown', colorRole: 'neutral' });
    });
});

describe('Users grid facet options (server-side filter values)', () => {
    it('Status facet labels map to the real resourceStatus enum values', () => {
        expect(USER_STATUS_FACET_OPTIONS).toEqual([
            { label: 'Active', value: 'ENABLED' },
            { label: 'Inactive', value: 'DISABLED' },
            { label: 'Archived', value: 'ARCHIVED' },
        ]);
    });

    it('Type facet maps to the isServiceAccount boolean (serialized as a string for the CSV filter)', () => {
        expect(USER_TYPE_FACET_OPTIONS).toEqual([
            { label: 'Human', value: 'false' },
            { label: 'Service account', value: 'true' },
        ]);
    });

    it('userTypeLabel reflects the service-account flag', () => {
        expect(userTypeLabel(true)).toBe('Service account');
        expect(userTypeLabel(false)).toBe('Human');
        expect(userTypeLabel(undefined)).toBe('Human');
    });
});
