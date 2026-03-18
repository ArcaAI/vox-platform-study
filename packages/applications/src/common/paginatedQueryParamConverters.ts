import {
    DbFilters,
    DefaultDbFieldType,
    ICountProps,
    IFindAllProps,
} from '@arcaai/domains';
import { PaginatedQuery } from './dto';

export function deserializeSearchFieldString(
    searchFieldsString: string,
): string[] {
    return searchFieldsString.split(',').map((field) => field.trim());
}

export function deserializeFilterString<T = DefaultDbFieldType>(
    filtersString: string,
): DbFilters {
    const fields = filtersString.split(';');
    const filterObject: DbFilters<T> = {};

    fields.forEach((field) => {
        if (field.startsWith('AND[')) {
            const innerFiltersString = field.slice(4, -1);
            filterObject.AND = innerFiltersString
                .split(',')
                .map((f) => deserializeFilterString<T>(f));
        } else if (field.startsWith('OR[')) {
            const innerFiltersString = field.slice(3, -1);
            filterObject.OR = innerFiltersString
                .split(',')
                .map((f) => deserializeFilterString<T>(f));
        } else {
            const [key, opAndValue] = field.split('[');
            if (opAndValue) {
                const [op, value] = opAndValue.split(']:');
                const opKey = op as keyof DbFilters<T>[keyof T];
                if (!filterObject[key as keyof T]) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    filterObject[key as keyof T] = {} as any;
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (filterObject[key as keyof T] as any)[opKey] = value;
            }
        }
    });

    return filterObject;
}

export function deserializeSortString(
    sortString: string,
): { [key: string]: 'asc' | 'desc' }[] {
    const fields = sortString.split(',');
    const sortObjects: { [key: string]: 'asc' | 'desc' }[] = [];
    fields.forEach((field) => {
        const [key, value] = field.split(':').map((part) => part.trim());
        sortObjects.push({ [key]: value as 'asc' | 'desc' });
    });
    return sortObjects;
}

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export function withFormattedPaginatedProps<T>(
    props: PaginatedQuery,
): IFindAllProps<T> {
    return {
        page: props.page || 0,
        limit: props.limit || DEFAULT_PAGE_SIZE,
        search: props.search,
        searchFields: props.searchFields
            ? deserializeSearchFieldString(props.searchFields)
            : undefined,
        filters: props.filters
            ? deserializeFilterString(props.filters)
            : undefined,
        sort: props.sort ? deserializeSortString(props.sort) : undefined,
    };
}

export function withFormattedCountProps(props: PaginatedQuery): ICountProps {
    return {
        search: props.search,
        searchFields: props.searchFields
            ? deserializeSearchFieldString(props.searchFields)
            : undefined,
        filters: props.filters
            ? deserializeFilterString(props.filters)
            : undefined,
    };
}
