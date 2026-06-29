import { describe, expect, it } from 'vitest';
import { toUserListQuery } from '../user-query';

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
