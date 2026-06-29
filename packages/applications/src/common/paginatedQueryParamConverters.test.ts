import {
    deserializeSearchFieldString,
    deserializeFilterString,
    deserializeSortString,
    withFormattedPaginatedProps,
    withFormattedCountProps,
} from './paginatedQueryParamConverters';
import { AUDIT_LOG_FILTER_FIELD_TYPES, USER_FILTER_FIELD_TYPES } from './modelFilterTypes';
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

describe('deserializeFilterString — type-aware boolean coercion (DEFECT-F1)', () => {
    it('coerces a declared boolean field from its string CSV value to a real boolean', () => {
        // Before the fix `isServiceAccount[equals]:true` reached Prisma as
        // `{ equals: 'true' }` (a string) and 400d on the Bool column.
        expect(deserializeFilterString('isServiceAccount[equals]:true', ['isServiceAccount'])).toEqual({
            isServiceAccount: { equals: true },
        });
        expect(deserializeFilterString('isServiceAccount[equals]:false', ['isServiceAccount'])).toEqual({
            isServiceAccount: { equals: false },
        });
    });

    it('leaves NON-declared filters as strings — no blind true/false coercion', () => {
        // A genuine string column whose value happens to be "true" MUST stay a
        // string (coercing every 'true' would corrupt real string filters).
        expect(deserializeFilterString('username[equals]:true', ['isServiceAccount'])).toEqual({
            username: { equals: 'true' },
        });
        // And an ordinary string `contains` filter is untouched.
        expect(deserializeFilterString('username[contains]:doctor', ['isServiceAccount'])).toEqual({
            username: { contains: 'doctor' },
        });
    });

    it('only coerces the exact tokens "true"/"false" for declared fields', () => {
        // A non-boolean-looking value on a declared field is left alone rather
        // than mangled into `false`/`NaN`.
        expect(deserializeFilterString('isServiceAccount[equals]:maybe', ['isServiceAccount'])).toEqual({
            isServiceAccount: { equals: 'maybe' },
        });
    });

    it('is a no-op without a boolean allow-list (back-compat: everything stays a string)', () => {
        expect(deserializeFilterString('isServiceAccount[equals]:true')).toEqual({
            isServiceAccount: { equals: 'true' },
        });
    });

    it('coerces a declared boolean field nested inside an AND group', () => {
        expect(deserializeFilterString('AND[isServiceAccount[equals]:true]', ['isServiceAccount'])).toEqual({
            AND: [{ isServiceAccount: { equals: true } }],
        });
    });

    it('withFormattedPaginatedProps + withFormattedCountProps coerce declared boolean fields identically', () => {
        const props = { filters: 'isServiceAccount[equals]:true' };
        expect(withFormattedPaginatedProps(props, ['isServiceAccount']).filters).toEqual({
            isServiceAccount: { equals: true },
        });
        expect(withFormattedCountProps(props, ['isServiceAccount']).filters).toEqual({
            isServiceAccount: { equals: true },
        });
    });
});

describe('deserializeFilterString — model-aware coercion (TASK-375 §8 generic)', () => {
    // Coercion is now driven by the TARGET model's scalar field types (derived
    // from the generated Prisma types), so a resource passes its model NAME
    // instead of per-column opt-in lists. boolean/number/date columns coerce
    // automatically; String/enum/JSON columns and unknown fields stay strings.

    it('coerces boolean columns of the target model (isServiceAccount keeps working)', () => {
        expect(deserializeFilterString('isServiceAccount[equals]:true', 'User')).toEqual({
            isServiceAccount: { equals: true },
        });
        expect(deserializeFilterString('isServiceAccount[equals]:false', 'User')).toEqual({
            isServiceAccount: { equals: false },
        });
    });

    it('coerces numeric columns of the target model from numeric strings', () => {
        expect(deserializeFilterString('version[gte]:2', 'User')).toEqual({ version: { gte: 2 } });
        expect(deserializeFilterString('version[equals]:0', 'User')).toEqual({ version: { equals: 0 } });
    });

    it('coerces date/datetime columns of the target model from ISO strings', () => {
        expect(deserializeFilterString('createdAt[gte]:2026-01-01', 'User')).toEqual({
            createdAt: { gte: new Date('2026-01-01') },
        });
        expect(deserializeFilterString('lastLoginAt[lt]:2026-06-27T12:00:00.000Z', 'User')).toEqual({
            lastLoginAt: { lt: new Date('2026-06-27T12:00:00.000Z') },
        });
    });

    it('leaves String and enum columns of the model as strings', () => {
        // username is a String column
        expect(deserializeFilterString('username[contains]:doctor', 'User')).toEqual({
            username: { contains: 'doctor' },
        });
        // resourceStatus is an enum column → passthrough string
        expect(deserializeFilterString('resourceStatus[equals]:ENABLED', 'User')).toEqual({
            resourceStatus: { equals: 'ENABLED' },
        });
        // a genuine String column whose value is literally "true" stays a string
        expect(deserializeFilterString('username[equals]:true', 'User')).toEqual({
            username: { equals: 'true' },
        });
    });

    it('leaves unknown fields (not on the model) untouched', () => {
        expect(deserializeFilterString('notAColumn[equals]:true', 'User')).toEqual({
            notAColumn: { equals: 'true' },
        });
    });

    it('is a no-op for an unknown model name (back-compat safe — no blind coercion)', () => {
        expect(deserializeFilterString('isServiceAccount[equals]:true', 'NotARealModel')).toEqual({
            isServiceAccount: { equals: 'true' },
        });
    });

    it('only coerces recognizable tokens — malformed values pass through unchanged', () => {
        expect(deserializeFilterString('isServiceAccount[equals]:maybe', 'User')).toEqual({
            isServiceAccount: { equals: 'maybe' },
        });
        expect(deserializeFilterString('version[equals]:abc', 'User')).toEqual({
            version: { equals: 'abc' },
        });
        expect(deserializeFilterString('createdAt[equals]:notadate', 'User')).toEqual({
            createdAt: { equals: 'notadate' },
        });
    });

    it('covers another model (AuditLog) — previously-uncoerced boolean/number/date columns now coerce', () => {
        expect(deserializeFilterString('success[equals]:false', 'AuditLog')).toEqual({
            success: { equals: false },
        });
        expect(deserializeFilterString('version[gt]:5', 'AuditLog')).toEqual({ version: { gt: 5 } });
        expect(deserializeFilterString('createdAt[gte]:2026-01-01', 'AuditLog')).toEqual({
            createdAt: { gte: new Date('2026-01-01') },
        });
    });

    it('coerces model columns nested inside an AND group', () => {
        expect(deserializeFilterString('AND[isServiceAccount[equals]:true]', 'User')).toEqual({
            AND: [{ isServiceAccount: { equals: true } }],
        });
    });

    it('still supports the legacy boolean allow-list (array) form unchanged', () => {
        expect(deserializeFilterString('isServiceAccount[equals]:true', ['isServiceAccount'])).toEqual({
            isServiceAccount: { equals: true },
        });
    });

    it('supports an explicit field→type map', () => {
        expect(deserializeFilterString('count[gte]:10', { count: 'number' })).toEqual({
            count: { gte: 10 },
        });
    });

    it('back-compat: without any field types every value stays a byte-identical string', () => {
        expect(deserializeFilterString('version[gte]:2;createdAt[gte]:2026-01-01')).toEqual({
            version: { gte: '2' },
            createdAt: { gte: '2026-01-01' },
        });
    });

    it('withFormatted{Paginated,Count}Props accept a model name and coerce identically', () => {
        const props = { filters: 'isServiceAccount[equals]:true;version[gte]:2' };
        expect(withFormattedPaginatedProps(props, 'User').filters).toEqual({
            isServiceAccount: { equals: true },
            version: { gte: 2 },
        });
        expect(withFormattedCountProps(props, 'User').filters).toEqual({
            isServiceAccount: { equals: true },
            version: { gte: 2 },
        });
    });
});

describe('deserializeFilterString — enum / JSON column coercion (TASK-375 §8 follow-up)', () => {
    // Enum and JSON columns are now FIRST-CLASS recognized by the model field-type
    // registry (drift-guarded by the `satisfies ModelFilterFieldTypes<T>` mapped
    // type) rather than being silently bucketed with "unknown / String". Their
    // runtime coercion is a conservative PASS-THROUGH (the value stays the
    // original string): Prisma accepts a string for an enum filter, and JSON
    // filtering needs path operators the `field[op]:value` CSV grammar can't
    // express — so neither is ever mis-coerced.

    it('registry classifies AuditLog enum columns as "enum"', () => {
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceType).toBe('enum');
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.action).toBe('enum');
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceStatus).toBe('enum');
    });

    it('registry classifies AuditLog JSON columns as "json"', () => {
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.data).toBe('json');
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.previousData).toBe('json');
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.metadata).toBe('json');
        expect(AUDIT_LOG_FILTER_FIELD_TYPES.metaData).toBe('json');
    });

    it('registry classifies User enum + JSON columns', () => {
        expect(USER_FILTER_FIELD_TYPES.resourceStatus).toBe('enum');
        expect(USER_FILTER_FIELD_TYPES.metaData).toBe('json');
    });

    it('coerces an enum column by passing the valid enum string through unchanged', () => {
        expect(deserializeFilterString('action[equals]:CREATE', 'AuditLog')).toEqual({
            action: { equals: 'CREATE' },
        });
        expect(deserializeFilterString('resourceType[equals]:User', 'AuditLog')).toEqual({
            resourceType: { equals: 'User' },
        });
        // `in` lists and the User resourceStatus enum behave identically.
        expect(deserializeFilterString('resourceStatus[equals]:ENABLED', 'User')).toEqual({
            resourceStatus: { equals: 'ENABLED' },
        });
    });

    it('does NOT mangle an unrecognized enum string — it passes through (Prisma validates)', () => {
        // A bogus enum member is NOT coerced to anything; Prisma rejects it
        // server-side exactly as before — we never silently change the value.
        expect(deserializeFilterString('action[equals]:NOT_A_REAL_ACTION', 'AuditLog')).toEqual({
            action: { equals: 'NOT_A_REAL_ACTION' },
        });
    });

    it('coerces a JSON column as a safe string pass-through (no path-operator support)', () => {
        // JSON path filtering is intentionally NOT supported via the CSV contract;
        // the value is left a string so it is never silently mis-coerced.
        expect(deserializeFilterString('data[equals]:{"k":1}', 'AuditLog')).toEqual({
            data: { equals: '{"k":1}' },
        });
        expect(deserializeFilterString('metaData[equals]:x', 'User')).toEqual({
            metaData: { equals: 'x' },
        });
    });

    it('still coerces boolean/number/date on the same model (no regression)', () => {
        expect(deserializeFilterString('success[equals]:false;version[gt]:5;createdAt[gte]:2026-01-01', 'AuditLog')).toEqual({
            success: { equals: false },
            version: { gt: 5 },
            createdAt: { gte: new Date('2026-01-01') },
        });
    });
});
