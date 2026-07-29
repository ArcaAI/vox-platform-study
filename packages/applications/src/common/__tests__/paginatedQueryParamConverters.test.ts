import { describe, it, expect } from 'vitest';
import {
  withFormattedCountProps,
  withFormattedPaginatedProps,
  deserializeSearchFieldString,
  deserializeFilterString,
  deserializeSortString,
} from '../paginatedQueryParamConverters';
import { PaginatedQuery } from '../dto';

describe('withFormattedCountProps', () => {
  it('should include deserialized searchFields when provided', () => {
    const props: PaginatedQuery = {
      search: 'john',
      searchFields: 'name,email',
    };

    const result = withFormattedCountProps(props);

    expect(result.search).toBe('john');
    expect(result.searchFields).toEqual(['name', 'email']);
  });

  it('should leave searchFields undefined when not provided', () => {
    const props: PaginatedQuery = {
      search: 'john',
    };

    const result = withFormattedCountProps(props);

    expect(result.search).toBe('john');
    expect(result.searchFields).toBeUndefined();
  });

  it('should include deserialized filters when provided', () => {
    const props: PaginatedQuery = {
      filters: 'status[equals]:ENABLED',
    };

    const result = withFormattedCountProps(props);

    expect(result.filters).toBeDefined();
    expect((result.filters as any).status).toEqual({ equals: 'ENABLED' });
  });

  it('should leave filters undefined when not provided', () => {
    const props: PaginatedQuery = {};

    const result = withFormattedCountProps(props);

    expect(result.filters).toBeUndefined();
  });

  it('should handle empty props', () => {
    const result = withFormattedCountProps({});

    expect(result.search).toBeUndefined();
    expect(result.searchFields).toBeUndefined();
    expect(result.filters).toBeUndefined();
  });

  it('should handle all props together', () => {
    const props: PaginatedQuery = {
      search: 'test',
      searchFields: 'name,description',
      filters: 'status[equals]:ENABLED',
    };

    const result = withFormattedCountProps(props);

    expect(result.search).toBe('test');
    expect(result.searchFields).toEqual(['name', 'description']);
    expect(result.filters).toBeDefined();
  });
});

describe('withFormattedPaginatedProps', () => {
  it('should default page to 0 when not provided', () => {
    const result = withFormattedPaginatedProps({});

    expect(result.page).toBe(0);
  });

  it('should default limit to 10 when not provided', () => {
    const result = withFormattedPaginatedProps({});

    expect(result.limit).toBe(10);
  });

  it('should pass through search', () => {
    const result = withFormattedPaginatedProps({ search: 'test' });

    expect(result.search).toBe('test');
  });

  it('should deserialize searchFields string to array', () => {
    const result = withFormattedPaginatedProps({
      searchFields: 'name, email, phone',
    });

    expect(result.searchFields).toEqual(['name', 'email', 'phone']);
  });

  it('should deserialize sort string', () => {
    const result = withFormattedPaginatedProps({
      sort: 'name:asc,createdAt:desc',
    });

    expect(result.sort).toEqual([{ name: 'asc' }, { createdAt: 'desc' }]);
  });
});

describe('deserializeSearchFieldString', () => {
  it('should split comma-separated fields', () => {
    expect(deserializeSearchFieldString('name,email')).toEqual(['name', 'email']);
  });

  it('should trim whitespace from fields', () => {
    expect(deserializeSearchFieldString('name , email , phone')).toEqual(['name', 'email', 'phone']);
  });

  it('should handle single field', () => {
    expect(deserializeSearchFieldString('name')).toEqual(['name']);
  });
});

describe('deserializeSortString', () => {
  it('should parse sort entries', () => {
    expect(deserializeSortString('name:asc')).toEqual([{ name: 'asc' }]);
  });

  it('should parse multiple sort entries', () => {
    expect(deserializeSortString('name:asc,createdAt:desc')).toEqual([{ name: 'asc' }, { createdAt: 'desc' }]);
  });
});
