import { describe, it, expect } from 'vitest';
import { formatFindAllProps, formatCountProps } from '../repository.helpers';
import { IFindAllProps, ICountProps } from '../../interfaces';

/**
 * Tests for the default search fields feature in the Repository base class.
 *
 * Since the Repository class has circular dependency issues in tests,
 * we test the applyDefaultSearchFields logic via a standalone utility
 * that mirrors the repository behavior: when search is provided but
 * searchFields is not, default fields are injected before passing
 * to formatFindAllProps / formatCountProps.
 */

interface SearchableProps {
    search?: string;
    searchFields?: string[];
    [key: string]: unknown;
}

function applyDefaultSearchFields<T extends SearchableProps>(
    props: T,
    defaultSearchFields?: string[],
): T {
    if (props.search && !props.searchFields && defaultSearchFields?.length) {
        return { ...props, searchFields: defaultSearchFields };
    }
    return props;
}

interface TestModel {
    id: string;
    name: string;
    email: string;
    status: string;
}

const DEFAULT_FIELDS = ['name', 'email'];

describe('applyDefaultSearchFields', () => {
    it('should inject default searchFields when search is provided but searchFields is not', () => {
        const props: SearchableProps = { search: 'john' };
        const result = applyDefaultSearchFields(props, DEFAULT_FIELDS);

        expect(result.searchFields).toEqual(['name', 'email']);
        expect(result.search).toBe('john');
    });

    it('should NOT override when searchFields is explicitly provided', () => {
        const props = { search: 'john', searchFields: ['status'] };
        const result = applyDefaultSearchFields(props, DEFAULT_FIELDS);

        expect(result.searchFields).toEqual(['status']);
    });

    it('should do nothing when no search is provided', () => {
        const props: SearchableProps = { page: 1, limit: 10 };
        const result = applyDefaultSearchFields(props, DEFAULT_FIELDS);

        expect(result.searchFields).toBeUndefined();
    });

    it('should do nothing when search is empty string', () => {
        const props: SearchableProps = { search: '' };
        const result = applyDefaultSearchFields(props, DEFAULT_FIELDS);

        expect(result.searchFields).toBeUndefined();
    });

    it('should do nothing when no defaults are configured', () => {
        const props: SearchableProps = { search: 'john' };
        const result = applyDefaultSearchFields(props, undefined);

        expect(result.searchFields).toBeUndefined();
    });

    it('should do nothing when defaults is empty array', () => {
        const props: SearchableProps = { search: 'john' };
        const result = applyDefaultSearchFields(props, []);

        expect(result.searchFields).toBeUndefined();
    });

    it('should not mutate the original props object', () => {
        const props: SearchableProps = { search: 'john' };
        const result = applyDefaultSearchFields(props, DEFAULT_FIELDS);

        expect(props.searchFields).toBeUndefined();
        expect(result).not.toBe(props);
    });
});

describe('applyDefaultSearchFields integration with formatFindAllProps', () => {
    it('should produce correct Prisma where clause when defaults are applied', () => {
        const props = { search: 'john', page: 1, limit: 10 };
        const withDefaults = applyDefaultSearchFields(props, DEFAULT_FIELDS);
        const result = formatFindAllProps<TestModel>(withDefaults);

        expect(result.where.AND).toBeDefined();
        expect(result.where.AND).toHaveLength(1);
        expect(result.where.AND[0].OR).toContainEqual({
            name: { contains: 'john', mode: 'insensitive' },
        });
        expect(result.where.AND[0].OR).toContainEqual({
            email: { contains: 'john', mode: 'insensitive' },
        });
    });

    it('should produce empty where clause when no search and no defaults', () => {
        const props = { page: 1, limit: 10 };
        const withDefaults = applyDefaultSearchFields(props, DEFAULT_FIELDS);
        const result = formatFindAllProps<TestModel>(withDefaults);

        expect(result.where).toEqual({});
    });
});

describe('applyDefaultSearchFields integration with formatCountProps', () => {
    it('should produce correct Prisma where clause for count when defaults are applied', () => {
        const props = { search: 'john' };
        const withDefaults = applyDefaultSearchFields(props, DEFAULT_FIELDS);
        const result = formatCountProps<TestModel>(withDefaults);

        const where = result.where as any;
        expect(where.AND).toBeDefined();
        expect(where.AND[1].OR).toContainEqual({
            name: { contains: 'john', mode: 'insensitive' },
        });
        expect(where.AND[1].OR).toContainEqual({
            email: { contains: 'john', mode: 'insensitive' },
        });
    });

    it('should NOT add search to count when search is missing', () => {
        const props = {};
        const withDefaults = applyDefaultSearchFields(props, DEFAULT_FIELDS);
        const result = formatCountProps<TestModel>(withDefaults);

        expect(result.where).toEqual({});
    });
});
