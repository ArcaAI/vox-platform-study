import { describe, expect, it } from 'vitest';
import { buildTenantUserListQuery } from '../tenant-user-query';

describe('buildTenantUserListQuery (tenant member grid → UserListQuery)', () => {
    it('translates the 0-based grid page to the backend 1-based page', () => {
        expect(buildTenantUserListQuery({ page: 0, limit: 20 })).toEqual({ page: 1, limit: 20 });
        expect(buildTenantUserListQuery({ page: 2, limit: 50 })).toEqual({ page: 3, limit: 50 });
    });

    it('forwards a search term', () => {
        expect(buildTenantUserListQuery({ page: 0, limit: 20, search: 'ana' })).toEqual({
            page: 1,
            limit: 20,
            search: 'ana',
        });
    });

    it('builds the resourceStatus filter CSV', () => {
        expect(buildTenantUserListQuery({ page: 0, limit: 20, status: 'ENABLED' })).toEqual({
            page: 1,
            limit: 20,
            filters: 'resourceStatus:ENABLED',
        });
    });

    it('omits empty/whitespace search and absent status (graceful degradation)', () => {
        const q = buildTenantUserListQuery({ page: 0, limit: 20, search: '   ' });
        expect(q).toEqual({ page: 1, limit: 20 });
        expect(q.search).toBeUndefined();
        expect(q.filters).toBeUndefined();
    });
});
