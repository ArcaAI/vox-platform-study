import {
    deserializeSearchFieldString,
    deserializeFilterString,
    deserializeSortString,
    withFormattedPaginatedProps,
    withFormattedCountProps,
} from './paginatedQueryParamConverters';
import { describe, it, expect } from 'vitest';

describe('paginatedQueryParamConverters', () => {
    it('should correctly deserialize search field string', () => {
        const searchFieldsString = 'field1,field2,field3';
        const result = deserializeSearchFieldString(searchFieldsString);
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('should correctly deserialize filter string', () => {
        const filtersString = 'field1[eq]:value1;field2[gt]:value2';
        const result = deserializeFilterString(filtersString);
        expect(result).toEqual({
            field1: { eq: 'value1' },
            field2: { gt: 'value2' },
        });
    });

    it('should correctly deserialize sort string', () => {
        const sortString = 'field1:asc,field2:desc';
        const result = deserializeSortString(sortString);
        expect(result).toEqual([{ field1: 'asc' }, { field2: 'desc' }]);
    });

    it('should correctly format paginated props', () => {
        const props = {
            page: 1,
            limit: 10,
            search: 'test',
            searchFields: 'field1,field2',
            filters: 'field1[eq]:value1;field2[gt]:value2',
            sort: 'field1:asc,field2:desc',
        };
        const result = withFormattedPaginatedProps(props);
        expect(result).toEqual({
            page: 1,
            limit: 10,
            search: 'test',
            searchFields: ['field1', 'field2'],
            filters: {
                field1: { eq: 'value1' },
                field2: { gt: 'value2' },
            },
            sort: [{ field1: 'asc' }, { field2: 'desc' }],
        });
    });

    it('should correctly format count props', () => {
        const props = {
            search: 'test',
            searchFields: 'field1,field2',
            filters: 'field1[eq]:value1;field2[gt]:value2',
        };
        const result = withFormattedCountProps(props);
        expect(result).toEqual({
            search: 'test',
            searchFields: ['field1', 'field2'],
            filters: {
                field1: { eq: 'value1' },
                field2: { gt: 'value2' },
            },
        });
    });
});
