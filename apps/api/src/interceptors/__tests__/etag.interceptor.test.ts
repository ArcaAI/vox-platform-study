/**
 * ETagInterceptor unit tests.
 *
 * The interceptor scans every response body that flows through and, when it
 * spots a top-level `version: <positive integer>`, emits an RFC 7232
 * strong-comparison `ETag` header (`"<n>"`, no `W/` prefix). Collections
 * (`{ data: [...] }`), responses without `.version`, and primitives are
 * passed through unchanged.
 *
 * Strong validators are required because the `If-Match` precondition on
 * PATCH must use strong comparison (RFC 7232 §2.3.2 / §3.1).
 *
 * @see apps/api/src/interceptors/etag.interceptor.ts
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-2.3.2
 */
import { describe, it, expect, vi } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ETagInterceptor } from '../etag.interceptor';

const makeContext = (response: { setHeader: ReturnType<typeof vi.fn> }): ExecutionContext =>
    ({
        switchToHttp: () => ({
            getResponse: () => response,
            getRequest: () => ({}),
        }),
    }) as unknown as ExecutionContext;

describe('ETagInterceptor (TASK-302 Stream D Phase D)', () => {
    it('sets ETag from body.version', async () => {
        const res = { setHeader: vi.fn() };
        const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
        const interceptor = new ETagInterceptor();
        const result = await lastValueFrom(interceptor.intercept(makeContext(res), next));
        expect(res.setHeader).toHaveBeenCalledWith('ETag', '"7"');
        expect(result).toEqual({ id: 'x', version: 7 });
    });

    it('does not set ETag when body has no version', async () => {
        const res = { setHeader: vi.fn() };
        const next: CallHandler = { handle: () => of({ id: 'x' }) };
        const interceptor = new ETagInterceptor();
        await lastValueFrom(interceptor.intercept(makeContext(res), next));
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('does NOT set ETag for collection responses (FetchResponse wrapper)', async () => {
        const res = { setHeader: vi.fn() };
        const next: CallHandler = { handle: () => of({ data: [{ id: 'x', version: 4 }] }) };
        const interceptor = new ETagInterceptor();
        await lastValueFrom(interceptor.intercept(makeContext(res), next));
        // Collections don't carry a single ETag — interceptor must not set one.
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('does NOT set ETag for non-positive version (0)', async () => {
        // Defensive: `version: 0` would render as `ETag: "0"` and break the
        // OCC contract (the row's _version starts at 1 per the schema default).
        const res = { setHeader: vi.fn() };
        const next: CallHandler = { handle: () => of({ id: 'x', version: 0 }) };
        const interceptor = new ETagInterceptor();
        await lastValueFrom(interceptor.intercept(makeContext(res), next));
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('does NOT set ETag for non-integer version (string)', async () => {
        // If a service ever returns version as a string (legacy mapper bug),
        // we must not render it as an ETag — that would mask the real
        // problem with a syntactically-valid-but-semantically-broken token.
        const res = { setHeader: vi.fn() };
        const next: CallHandler = { handle: () => of({ id: 'x', version: '7' as unknown as number }) };
        const interceptor = new ETagInterceptor();
        await lastValueFrom(interceptor.intercept(makeContext(res), next));
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('passes the body through unchanged regardless of header decision', async () => {
        const res = { setHeader: vi.fn() };
        const body = { id: 'x', version: 12, name: 'tenant' };
        const next: CallHandler = { handle: () => of(body) };
        const interceptor = new ETagInterceptor();
        const result = await lastValueFrom(interceptor.intercept(makeContext(res), next));
        expect(result).toBe(body);
    });
});
