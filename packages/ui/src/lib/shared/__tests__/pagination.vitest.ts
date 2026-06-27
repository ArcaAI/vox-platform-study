import { describe, it, expect } from 'vitest';
import { fromSdkPaginated, fromServerPaginated } from '../pagination';

describe('lib/shared/pagination', () => {
  describe('fromSdkPaginated', () => {
    it('maps the SDK extractPaginated shape (data/total/page/limit/totalPages/hasMore) to PageResult', () => {
      const result = fromSdkPaginated({
        data: [{ id: 'a' }, { id: 'b' }],
        total: 42,
        page: 0,
        limit: 20,
        totalPages: 3,
        hasMore: true,
      });

      expect(result.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(result.total).toBe(42);
      expect(result.page).toBe(0);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(3);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('fromServerPaginated', () => {
    it('maps the raw server envelope ({data,count,page,limit}) and computes totalPages + hasMore', () => {
      const result = fromServerPaginated({ data: [1, 2], count: 50, page: 0, limit: 20 });

      expect(result.rows).toEqual([1, 2]);
      expect(result.total).toBe(50);
      expect(result.page).toBe(0);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(3); // ceil(50/20)
      expect(result.hasMore).toBe(true); // (0+1)*20 < 50
    });

    it('reports hasMore=false on the last page', () => {
      const result = fromServerPaginated({ data: [1, 2], count: 50, page: 2, limit: 20 });
      expect(result.hasMore).toBe(false); // (2+1)*20 >= 50
    });

    it('normalizes a 1-based page (ContextFiltersDto / PaginatedContextItemResponse) to 0-based', () => {
      const result = fromServerPaginated({ data: [], count: 30, page: 1, limit: 10 }, { pageBase: 1 });
      expect(result.page).toBe(0);
    });

    it('does not divide by zero when limit is 0', () => {
      const result = fromServerPaginated({ data: [], count: 0, page: 0, limit: 0 });
      expect(result.totalPages).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });
});
