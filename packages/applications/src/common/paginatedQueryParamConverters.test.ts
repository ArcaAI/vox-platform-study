import {
  deserializeSearchFieldString,
  deserializeFilterString,
  deserializeSortString,
  withFormattedPaginatedProps,
  withFormattedCountProps,
} from './paginatedQueryParamConverters';
import { AUDIT_LOG_FILTER_FIELD_TYPES, MODEL_FILTER_FIELD_TYPES, USER_FILTER_FIELD_TYPES } from './modelFilterTypes';
import { BadRequestException } from '@nestjs/common';
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

describe('deserializeFilterString — type-aware boolean coercion', () => {
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

describe('deserializeFilterString — model-aware coercion (generic)', () => {
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

describe('deserializeFilterString — enum / JSON column coercion (follow-up)', () => {
  // Enum and JSON columns are FIRST-CLASS recognized by the model field-type
  // registry (drift-guarded by the `satisfies ModelFilterFieldTypes<T>` mapped
  // type) rather than being silently bucketed with "unknown / String".
  // Enum columns carry a runtime
  // MEMBER allow-list (`{ type: 'enum', members }`, sourced from the
  // `@arcaai/domains` generated enum objects) and an invalid member is
  // rejected with a 400 instead of being deferred to Prisma; JSON columns
  // stay safe pass-throughs at the whole-column level (path filtering is the
  // separate dotted-key grammar below).

  it('registry classifies AuditLog enum columns as member-carrying enum specs', () => {
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceType.type).toBe('enum');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceType.members).toContain('User');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.action.type).toBe('enum');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.action.members).toContain('CREATE');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceStatus.type).toBe('enum');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.resourceStatus.members).toContain('ENABLED');
  });

  it('registry classifies AuditLog JSON columns as "json"', () => {
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.data).toBe('json');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.previousData).toBe('json');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.metadata).toBe('json');
    expect(AUDIT_LOG_FILTER_FIELD_TYPES.metaData).toBe('json');
  });

  it('registry classifies User enum + JSON columns', () => {
    expect(USER_FILTER_FIELD_TYPES.resourceStatus.type).toBe('enum');
    expect(USER_FILTER_FIELD_TYPES.resourceStatus.members).toContain('ENABLED');
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

  it('rejects an unrecognized enum member with a 400 instead of deferring to Prisma', () => {
    // A bogus member previously passed through for Prisma to reject
    // server-side (a 500-class error). The registry now carries the member allow-list, so an
    // invalid member is a clean client error naming the allowed members.
    expect(() => deserializeFilterString('action[equals]:NOT_A_REAL_ACTION', 'AuditLog')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('action[equals]:NOT_A_REAL_ACTION', 'AuditLog')).toThrow(/NOT_A_REAL_ACTION.*action/s);
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

describe('deserializeFilterString — enum MEMBER validation', () => {
  it('validates members inside AND / OR groups too (recursion reuses the resolved map)', () => {
    expect(() => deserializeFilterString('AND[action[equals]:CREATE,action[equals]:BOGUS]', 'AuditLog')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('OR[resourceStatus[equals]:NOPE]', 'User')).toThrow(BadRequestException);
    // Valid members inside groups still deserialize normally.
    expect(deserializeFilterString('AND[action[equals]:CREATE,success[equals]:true]', 'AuditLog')).toEqual({
      AND: [{ action: { equals: 'CREATE' } }, { success: { equals: true } }],
    });
  });

  it("keeps a plain 'enum' tag in an EXPLICIT map as an unvalidated pass-through (legacy escape hatch)", () => {
    // Only member-carrying registry specs validate; an explicit map that
    // says just 'enum' has no allow-list and keeps the legacy behaviour.
    expect(deserializeFilterString('status[equals]:ANYTHING', { status: 'enum' })).toEqual({
      status: { equals: 'ANYTHING' },
    });
  });

  it('error message names the field, the bad value and the allowed members', () => {
    try {
      deserializeFilterString('resourceStatus[equals]:BROKEN', 'User');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      expect(message).toContain('resourceStatus');
      expect(message).toContain('BROKEN');
      expect(message).toContain('ENABLED');
      expect(message).toContain('DISABLED');
    }
  });
});

describe('deserializeFilterString — JSON-path filtering', () => {
  it('deserializes a dotted key on a declared JSON column into a Prisma path filter', () => {
    expect(deserializeFilterString('metaData.subType[equals]:recording', 'User')).toEqual({
      metaData: { path: ['subType'], equals: 'recording' },
    });
  });

  it('supports deep paths', () => {
    expect(deserializeFilterString('metaData.a.b.c[equals]:x', 'User')).toEqual({
      metaData: { path: ['a', 'b', 'c'], equals: 'x' },
    });
  });

  it('coerces JSON literals (numbers / booleans / null) for value operators', () => {
    expect(deserializeFilterString('metaData.count[gt]:5', 'User')).toEqual({
      metaData: { path: ['count'], gt: 5 },
    });
    expect(deserializeFilterString('metaData.flag[equals]:true', 'User')).toEqual({
      metaData: { path: ['flag'], equals: true },
    });
    expect(deserializeFilterString('metaData.maybe[equals]:null', 'User')).toEqual({
      metaData: { path: ['maybe'], equals: null },
    });
    // A non-JSON token stays the raw string.
    expect(deserializeFilterString('metaData.kind[equals]:recording-audio', 'User')).toEqual({
      metaData: { path: ['kind'], equals: 'recording-audio' },
    });
  });

  it('keeps raw strings for string_* operators (they only apply to strings)', () => {
    expect(deserializeFilterString('metaData.subType[string_contains]:rec', 'User')).toEqual({
      metaData: { path: ['subType'], string_contains: 'rec' },
    });
    // Even a numeric-looking token stays a string for string_* ops.
    expect(deserializeFilterString('metaData.code[string_starts_with]:123', 'User')).toEqual({
      metaData: { path: ['code'], string_starts_with: '123' },
    });
  });

  it('parses array values (hardened bracket parsing keeps [ and ]: inside values intact)', () => {
    expect(deserializeFilterString('metaData.tags[array_contains]:["a","b"]', 'User')).toEqual({
      metaData: { path: ['tags'], array_contains: ['a', 'b'] },
    });
  });

  it('rejects an operator outside the Prisma JSON path-filter allow-list with a 400', () => {
    expect(() => deserializeFilterString('metaData.subType[contains]:x', 'User')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('metaData.subType[contains]:x', 'User')).toThrow(/contains/);
  });

  it('rejects an empty path segment with a 400', () => {
    expect(() => deserializeFilterString('metaData..a[equals]:x', 'User')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('metaData.[equals]:x', 'User')).toThrow(BadRequestException);
  });

  it('merges multiple operators on the SAME path; conflicting paths on one column → 400 pointing at AND groups', () => {
    expect(deserializeFilterString('metaData.count[gte]:1;metaData.count[lte]:5', 'User')).toEqual({
      metaData: { path: ['count'], gte: 1, lte: 5 },
    });
    expect(() => deserializeFilterString('metaData.a[equals]:1;metaData.b[equals]:2', 'User')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('metaData.a[equals]:1;metaData.b[equals]:2', 'User')).toThrow(/AND/);
  });

  it('expresses different paths on one column via AND groups', () => {
    expect(deserializeFilterString('AND[metaData.a[equals]:1,metaData.b[equals]:2]', 'User')).toEqual({
      AND: [{ metaData: { path: ['a'], equals: 1 } }, { metaData: { path: ['b'], equals: 2 } }],
    });
  });

  it('leaves dotted keys byte-identical when the root is NOT a declared JSON column', () => {
    // Unknown root on a known model → literal key, exactly as before.
    expect(deserializeFilterString('some.path[equals]:x', 'User')).toEqual({
      'some.path': { equals: 'x' },
    });
    // No model context at all → literal key, exactly as before.
    expect(deserializeFilterString('some.path[equals]:x')).toEqual({
      'some.path': { equals: 'x' },
    });
    // Root is a known but non-JSON column → literal key.
    expect(deserializeFilterString('version.major[equals]:1', 'User')).toEqual({
      'version.major': { equals: '1' },
    });
  });

  it('whole-column JSON filters (no dot) keep the pass-through', () => {
    expect(deserializeFilterString('metaData[equals]:x', 'User')).toEqual({
      metaData: { equals: 'x' },
    });
  });
});

describe('model registry expansion — Tenant/Media/Role/Tag/Webhook/Notification', () => {
  it('registers all six additional models', () => {
    for (const model of ['Tenant', 'Media', 'Role', 'Tag', 'Webhook', 'Notification']) {
      expect(MODEL_FILTER_FIELD_TYPES[model], `registry entry for ${model}`).toBeDefined();
    }
  });

  it('Tenant: number / date / enum(+members) columns coerce', () => {
    expect(deserializeFilterString('version[gte]:2;trialEndsAt[lte]:2026-08-01;plan[equals]:TRIAL', 'Tenant')).toEqual({
      version: { gte: 2 },
      trialEndsAt: { lte: new Date('2026-08-01') },
      plan: { equals: 'TRIAL' },
    });
    expect(() => deserializeFilterString('plan[equals]:GOLD', 'Tenant')).toThrow(BadRequestException);
  });

  it('Media: size coerces to a number; resourceStatus is member-validated', () => {
    expect(deserializeFilterString('size[gte]:1000;resourceStatus[equals]:ENABLED', 'Media')).toEqual({
      size: { gte: 1000 },
      resourceStatus: { equals: 'ENABLED' },
    });
    expect(() => deserializeFilterString('resourceStatus[equals]:NOPE', 'Media')).toThrow(BadRequestException);
  });

  it('Role: isSystemRole coerces to a boolean', () => {
    expect(deserializeFilterString('isSystemRole[equals]:true;version[gt]:1', 'Role')).toEqual({
      isSystemRole: { equals: true },
      version: { gt: 1 },
    });
  });

  it('Tag: version/date columns coerce; strings stay strings', () => {
    expect(deserializeFilterString('version[gte]:2;createdAt[gte]:2026-01-01;tagValue[equals]:true', 'Tag')).toEqual({
      version: { gte: 2 },
      createdAt: { gte: new Date('2026-01-01') },
      tagValue: { equals: 'true' }, // String column — never mangled
    });
  });

  it('Webhook: subscriptionMetadata supports JSON-path filtering', () => {
    expect(deserializeFilterString('subscriptionMetadata.event[equals]:consultation.created', 'Webhook')).toEqual({
      subscriptionMetadata: { path: ['event'], equals: 'consultation.created' },
    });
  });

  it('Notification: read/keyVersion coerce; type is member-validated', () => {
    expect(deserializeFilterString('read[equals]:false;keyVersion[gte]:2;type[equals]:STANDARD', 'Notification')).toEqual({
      read: { equals: false },
      keyVersion: { gte: 2 },
      type: { equals: 'STANDARD' },
    });
    expect(() => deserializeFilterString('type[equals]:SHINY', 'Notification')).toThrow(BadRequestException);
  });
});

describe('deserializeFilterString — list operators in / notIn', () => {
  // `field[in]:v1|v2|v3` / `field[notIn]:v1|v2` deserialize to Prisma's
  // `{ in: [...] }` / `{ notIn: [...] }`. Items are '|'-separated and EACH
  // item runs through the same per-column coercion as a scalar token
  // (numbers/dates/booleans coerce, enum members validate with a 400, plain
  // strings pass through). Empty items are rejected with a 400 — never
  // silently dropped.

  it('deserializes [in] into an array (no field types — items stay strings)', () => {
    expect(deserializeFilterString('status[in]:A|B|C')).toEqual({
      status: { in: ['A', 'B', 'C'] },
    });
  });

  it('deserializes a single-item [in] into a one-element array', () => {
    expect(deserializeFilterString('status[in]:A')).toEqual({
      status: { in: ['A'] },
    });
  });

  it('deserializes [notIn] into an array', () => {
    expect(deserializeFilterString('status[notIn]:A|B')).toEqual({
      status: { notIn: ['A', 'B'] },
    });
  });

  it('coerces EACH item with the column type (number / date / boolean)', () => {
    expect(deserializeFilterString('version[in]:1|2|3', 'User')).toEqual({
      version: { in: [1, 2, 3] },
    });
    expect(deserializeFilterString('createdAt[in]:2026-01-01|2026-02-01', 'User')).toEqual({
      createdAt: { in: [new Date('2026-01-01'), new Date('2026-02-01')] },
    });
    expect(deserializeFilterString('isServiceAccount[in]:true|false', 'User')).toEqual({
      isServiceAccount: { in: [true, false] },
    });
  });

  it('validates EACH enum member of a list (a valid list passes through)', () => {
    expect(deserializeFilterString('action[in]:CREATE|UPDATE', 'AuditLog')).toEqual({
      action: { in: ['CREATE', 'UPDATE'] },
    });
    expect(deserializeFilterString('resourceStatus[notIn]:DELETED|ARCHIVED', 'User')).toEqual({
      resourceStatus: { notIn: ['DELETED', 'ARCHIVED'] },
    });
  });

  it('rejects an invalid enum member ANYWHERE in the list with a 400 naming the allowed members', () => {
    try {
      deserializeFilterString('action[in]:CREATE|BOGUS', 'AuditLog');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      expect(message).toContain('BOGUS');
      expect(message).toContain('action');
      expect(message).toContain('CREATE'); // the allowed members are listed
    }
  });

  it('rejects empty list items (trailing "|", "a||b", empty value) with a 400', () => {
    // Decision: empty items 400 rather than being filtered out — they
    // always indicate a client serializer bug, and silently dropping them
    // could turn the token into `{ in: [] }` (matches nothing).
    expect(() => deserializeFilterString('status[in]:A|')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('status[in]:A||B')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('status[in]:')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('status[notIn]:|A')).toThrow(BadRequestException);
  });

  it('works inside AND[…]/OR[…] groups (no collision between the "," group separator and "|" items)', () => {
    expect(deserializeFilterString('AND[action[in]:CREATE|UPDATE,success[equals]:true]', 'AuditLog')).toEqual({
      AND: [{ action: { in: ['CREATE', 'UPDATE'] } }, { success: { equals: true } }],
    });
    expect(deserializeFilterString('OR[resourceStatus[in]:ENABLED|DISABLED,version[gte]:2]', 'User')).toEqual({
      OR: [{ resourceStatus: { in: ['ENABLED', 'DISABLED'] } }, { version: { gte: 2 } }],
    });
  });

  it('still 400s for [in] on a JSON dotted path (NOT added to the JSON path operator allow-list)', () => {
    expect(() => deserializeFilterString('metaData.tags[in]:a|b', 'User')).toThrow(BadRequestException);
    expect(() => deserializeFilterString('metaData.tags[in]:a|b', 'User')).toThrow(/Unsupported JSON path filter operator 'in'/);
  });
});

describe('deserializeFilterString — case-insensitive string operators', () => {
  it('deserializes icontains / istartsWith / iendsWith / iequals to the base op + mode insensitive', () => {
    expect(deserializeFilterString('username[icontains]:doc')).toEqual({
      username: { contains: 'doc', mode: 'insensitive' },
    });
    expect(deserializeFilterString('username[istartsWith]:dr')).toEqual({
      username: { startsWith: 'dr', mode: 'insensitive' },
    });
    expect(deserializeFilterString('username[iendsWith]:son')).toEqual({
      username: { endsWith: 'son', mode: 'insensitive' },
    });
    expect(deserializeFilterString('username[iequals]:doctor')).toEqual({
      username: { equals: 'doctor', mode: 'insensitive' },
    });
  });

  it('keeps i-op values RAW strings (String-column operators — never coerced)', () => {
    // `mode: 'insensitive'` is only valid on Prisma String columns, where
    // coercion is a no-op anyway — so a date-looking value stays a string.
    expect(deserializeFilterString('username[icontains]:2026-01-01', 'User')).toEqual({
      username: { contains: '2026-01-01', mode: 'insensitive' },
    });
  });

  it('merges multiple i-ops on ONE field into a single insensitive filter object', () => {
    expect(deserializeFilterString('username[icontains]:doc;username[istartsWith]:dr')).toEqual({
      username: { contains: 'doc', startsWith: 'dr', mode: 'insensitive' },
    });
  });

  it('never leaks mode onto a sibling case-sensitive op on the same field (nests under AND instead)', () => {
    expect(deserializeFilterString('username[startsWith]:Dr;username[icontains]:smith')).toEqual({
      username: { startsWith: 'Dr' },
      AND: [{ username: { contains: 'smith', mode: 'insensitive' } }],
    });
    // Token order does not matter — same shape either way.
    expect(deserializeFilterString('username[icontains]:smith;username[startsWith]:Dr')).toEqual({
      username: { startsWith: 'Dr' },
      AND: [{ username: { contains: 'smith', mode: 'insensitive' } }],
    });
  });

  it('appends to an existing AND group without clobbering it', () => {
    expect(deserializeFilterString('AND[version[gte]:2];username[contains]:Dr;username[icontains]:smith', 'User')).toEqual({
      AND: [{ version: { gte: 2 } }, { username: { contains: 'smith', mode: 'insensitive' } }],
      username: { contains: 'Dr' },
    });
  });

  it('works inside OR groups (each group element folds its own buckets)', () => {
    expect(deserializeFilterString('OR[username[icontains]:doc,email[icontains]:doc]')).toEqual({
      OR: [{ username: { contains: 'doc', mode: 'insensitive' } }, { email: { contains: 'doc', mode: 'insensitive' } }],
    });
  });

  it('unchanged: plain contains/startsWith/endsWith stay case-sensitive (no mode key)', () => {
    expect(deserializeFilterString('username[contains]:doctor')).toEqual({
      username: { contains: 'doctor' },
    });
  });

  it("a literal '__proto__' field key never pollutes Object.prototype (own-key hardening)", () => {
    // Filter keys are attacker-controlled query-string input. Without
    // hardening, `filterObject['__proto__'][op] = value` would reach
    // Object.prototype and pollute EVERY object in the process.
    try {
      const result = deserializeFilterString('__proto__[in]:a|b;__proto__[icontains]:x;__proto__[equals]:y') as Record<string, unknown>;
      expect(({} as Record<string, unknown>).in).toBeUndefined();
      expect(({} as Record<string, unknown>).contains).toBeUndefined();
      expect(({} as Record<string, unknown>).equals).toBeUndefined();
      expect(({} as Record<string, unknown>).mode).toBeUndefined();
      // The key parses as an ordinary OWN property (Prisma will reject
      // the unknown column, same as any other bogus field name).
      expect(Object.keys(result)).toContain('__proto__');
    } finally {
      // Hygiene for a FAILING run: never leak pollution into other tests.
      /* eslint-disable @typescript-eslint/no-explicit-any */
      delete (Object.prototype as any).in;
      delete (Object.prototype as any).contains;
      delete (Object.prototype as any).equals;
      delete (Object.prototype as any).mode;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }
  });
});

describe('deserializeFilterString — range merge + wrapper integration', () => {
  it('merges gte+lte tokens for one regular (non-JSON) column into a single range object', () => {
    expect(deserializeFilterString('createdAt[gte]:2026-01-01;createdAt[lte]:2026-12-31', 'User')).toEqual({
      createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-12-31') },
    });
  });

  it('merges gte+lte without a model too (values stay strings, still one object)', () => {
    expect(deserializeFilterString('version[gte]:1;version[lte]:5')).toEqual({
      version: { gte: '1', lte: '5' },
    });
  });

  it('new operators flow through withFormatted{Paginated,Count}Props like any other token', () => {
    const props = { filters: 'resourceStatus[in]:ENABLED|DISABLED;username[icontains]:doc' };
    const expected = {
      resourceStatus: { in: ['ENABLED', 'DISABLED'] },
      username: { contains: 'doc', mode: 'insensitive' },
    };
    expect(withFormattedPaginatedProps(props, 'User').filters).toEqual(expected);
    expect(withFormattedCountProps(props, 'User').filters).toEqual(expected);
  });
});
