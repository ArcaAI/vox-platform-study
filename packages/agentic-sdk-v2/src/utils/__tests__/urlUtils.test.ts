/**
 * urlUtils Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { appendPagination, appendFilters } from '../urlUtils';

describe('appendPagination', () => {
  it('should return url unchanged when no pagination', () => {
    expect(appendPagination('/api/users')).toBe('/api/users');
  });

  it('should return url unchanged when pagination is undefined', () => {
    expect(appendPagination('/api/users', undefined)).toBe('/api/users');
  });

  it('should append page and limit', () => {
    expect(appendPagination('/api/users', { page: 2, limit: 10 })).toBe(
      '/api/users?page=2&limit=10',
    );
  });

  it('should use DEFAULT_PAGE_SIZE when limit is undefined', () => {
    expect(appendPagination('/api/users', { page: 3 })).toBe('/api/users?page=3&limit=10');
  });

  it('should append only limit when page is undefined', () => {
    expect(appendPagination('/api/users', { limit: 25 })).toBe('/api/users?limit=25');
  });

  it('should apply DEFAULT_PAGE_SIZE when both page and limit are undefined', () => {
    expect(appendPagination('/api/users', {})).toBe('/api/users?limit=10');
  });
});

describe('appendFilters', () => {
  it('should return url unchanged when filters are empty', () => {
    expect(appendFilters('/api/prompts', {})).toBe('/api/prompts');
  });

  it('should skip undefined values', () => {
    expect(appendFilters('/api/prompts', { category: undefined })).toBe('/api/prompts');
  });

  it('should append string filter', () => {
    expect(appendFilters('/api/prompts', { category: 'summary' })).toBe(
      '/api/prompts?category=summary',
    );
  });

  it('should join array values with commas', () => {
    expect(appendFilters('/api/prompts', { tags: ['a', 'b', 'c'] })).toBe(
      '/api/prompts?tags=a%2Cb%2Cc',
    );
  });

  it('should handle mixed string and array filters', () => {
    const result = appendFilters('/api/prompts', {
      category: 'summary',
      departmentId: 'dept-1',
      tags: ['urgent', 'review'],
      missing: undefined,
    });
    expect(result).toContain('category=summary');
    expect(result).toContain('departmentId=dept-1');
    expect(result).toContain('tags=urgent');
    expect(result).not.toContain('missing');
  });
});

describe('URL composition (no double ?)', () => {
  it('appendPagination should use & when url already has query string', () => {
    const url = '/api/prompts?category=summary';
    const result = appendPagination(url, { page: 2, limit: 10 });
    expect(result).toBe('/api/prompts?category=summary&page=2&limit=10');
    expect(result.split('?').length).toBe(2);
  });

  it('appendFilters should use & when url already has query string', () => {
    const url = '/api/prompts?page=1&limit=10';
    const result = appendFilters(url, { category: 'summary' });
    expect(result).toBe('/api/prompts?page=1&limit=10&category=summary');
    expect(result.split('?').length).toBe(2);
  });

  it('appendPagination then appendFilters should produce valid URL', () => {
    let url = '/api/prompts';
    url = appendPagination(url, { page: 1, limit: 25 });
    url = appendFilters(url, { category: 'summary', departmentId: 'dept-1' });
    expect(url.split('?').length).toBe(2);
    expect(url).toContain('page=1');
    expect(url).toContain('limit=25');
    expect(url).toContain('category=summary');
    expect(url).toContain('departmentId=dept-1');
  });

  it('appendFilters then appendPagination should produce valid URL', () => {
    let url = '/api/prompts';
    url = appendFilters(url, { tags: ['a', 'b'] });
    url = appendPagination(url, { page: 3 });
    expect(url.split('?').length).toBe(2);
    expect(url).toContain('tags=');
    expect(url).toContain('page=3');
    expect(url).toContain('limit=10');
  });

  it('appendPagination should not add & when url has no query string', () => {
    const result = appendPagination('/api/users', { page: 1 });
    expect(result).toBe('/api/users?page=1&limit=10');
  });

  it('appendFilters should not add & when url has no query string', () => {
    const result = appendFilters('/api/users', { status: 'active' });
    expect(result).toBe('/api/users?status=active');
  });
});
