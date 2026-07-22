/**
 * `@ExpectedVersion()` parameter decorator unit tests.
 *
 * Tests `extractExpectedVersion` (the underlying extractor) directly so we
 * can exercise the parser logic without spinning a Nest test module. The
 * decorator factory `createParamDecorator(extractExpectedVersion)` is the
 * thinnest possible wrapper and adds no logic to test.
 *
 * Contract:
 *   - `If-Match: "7"` (strong validator)         → returns `7`
 *   - `If-Match: "0"` (create-intent, owner decision) → returns `0`
 *   - Missing header on a NON-`@RequiresIfMatch()` route → returns `undefined`
 *     (allows the body-field fallback to take over for service-to-service)
 *   - Missing header on a `@RequiresIfMatch()`   → throws 428 Precondition
 *     Required (RFC 6585); the route guard sets `req._requiresIfMatch=true`.
 *   - Malformed (no quotes, leading zero, negative, weak `W/"..."`) → 400.
 *
 * @see apps/api/src/decorators/expectedVersion.decorator.ts
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
 * @see https://www.rfc-editor.org/rfc/rfc6585.html
 */
import { describe, it, expect } from 'vitest';
import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { extractExpectedVersion } from '../expectedVersion.decorator';
import type { ExecutionContext } from '@nestjs/common';

interface MockReq {
    headers: Record<string, string | undefined>;
    _requiresIfMatch?: boolean;
}

const ctx = (headers: Record<string, string | undefined>, requiresIfMatch = false): ExecutionContext =>
    ({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
            getRequest: (): MockReq => ({ headers, _requiresIfMatch: requiresIfMatch }),
        }),
    }) as unknown as ExecutionContext;

describe('extractExpectedVersion', () => {
    it('parses If-Match: "7" to 7', () => {
        expect(extractExpectedVersion(undefined, ctx({ 'if-match': '"7"' }))).toBe(7);
    });

    it('parses larger validators (multi-digit, no overflow)', () => {
        expect(extractExpectedVersion(undefined, ctx({ 'if-match': '"2147483647"' }))).toBe(2147483647);
    });

    it('returns undefined when header absent and route NOT @RequiresIfMatch', () => {
        // This is the body-field fallback gate: a missing header simply
        // means "the service layer's body-field expectedVersion will be
        // used." No HTTP error.
        expect(extractExpectedVersion(undefined, ctx({}))).toBeUndefined();
    });

    it('returns undefined when header is empty string and route NOT @RequiresIfMatch', () => {
        expect(extractExpectedVersion(undefined, ctx({ 'if-match': '' }))).toBeUndefined();
    });

    it('throws 428 when header absent and route IS @RequiresIfMatch', () => {
        let thrown: unknown;
        try {
            extractExpectedVersion(undefined, ctx({}, true));
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(HttpException);
        expect((thrown as HttpException).getStatus()).toBe(HttpStatus.PRECONDITION_REQUIRED);
        // The 428 body must include `code` so SDKs can distinguish it from
        // a generic 4xx and surface the right UX (vs. retrying blindly).
        const body = (thrown as HttpException).getResponse() as { code?: string };
        expect(body.code).toBe('HTTP.PRECONDITION_REQUIRED');
    });

    it('rejects malformed If-Match (no quotes around digits)', () => {
        // RFC 7232 §2.3 — entity-tags are quoted strings. A bare `7` is a
        // malformed validator and we refuse to guess intent.
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '7' }))).toThrow(BadRequestException);
    });

    it('rejects weak validator W/"7"', () => {
        // RFC 7232 §2.3.2 — weak comparison is not allowed for If-Match.
        // The `W/` prefix is the syntactic marker.
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': 'W/"7"' }))).toThrow(BadRequestException);
    });

    it('rejects negative integer', () => {
        // _version is monotonic from 1; a negative would mean the SDK lied.
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '"-1"' }))).toThrow(BadRequestException);
    });

    it('parses If-Match: "0" to 0 (create-intent owner decision)', () => {
        // "0" is the documented first-edit/create precondition across the
        // config plane (the `FIRST_EDIT_ETAG` convention): the caller
        // read a version-0 placeholder (no row yet) and echoes it. The service
        // CAS decides create-vs-412; the parser must let 0 through.
        expect(extractExpectedVersion(undefined, ctx({ 'if-match': '"0"' }))).toBe(0);
    });

    it('still rejects a leading-zero validator ("00", "007")', () => {
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '"00"' }))).toThrow(BadRequestException);
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '"007"' }))).toThrow(BadRequestException);
    });

    it('rejects non-numeric token inside quotes', () => {
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '"abc"' }))).toThrow(BadRequestException);
    });

    it('rejects If-Match: * wildcard (we require a concrete version)', () => {
        // RFC 7232 allows `*` to mean "if any representation exists" — but
        // that drops OCC and would let any caller bypass the CAS. We
        // explicitly refuse it.
        expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '*' }))).toThrow(BadRequestException);
    });
});
