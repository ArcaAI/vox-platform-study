/**
 * AgenticClient — Optimistic-locking transport tests
 *
 * @vitest-environment jsdom
 *
 * These tests pin the new HTTP-level helpers used by `useGlobalSettings`:
 *
 *   - `getWithEtag<T>` — returns `{ body, etag }`, capturing the response
 *     `ETag` header alongside the parsed body.
 *   - `patchWithIfMatch<T>` — sends an `If-Match` request header so the
 *     server-side CAS (`updateWithVersion`) can run.
 *
 * The two helpers are deliberately thin wrappers around the private
 * `requestWithMeta` so they inherit the existing auth/retry/rate-limit
 * machinery. We assert only the parts that are unique to the new API:
 * header propagation (request side) and header capture (response side).
 *
 * Pre-existing transport behaviors (401 refresh, retry-after, etc.) are
 * covered by `AgenticClient.test.ts` and intentionally not duplicated
 * here — the underlying code path is shared, so a regression there would
 * surface in both suites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { mockFetch, createMockResponse, createMockErrorResponse, createMockLogger } from '../../__tests__/setup';

describe('AgenticClient — optimistic-locking helpers', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-api-key',
        tenantId: 'tenant-123',
        timeout: 5000,
      },
      mockLogger,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getWithEtag<T>', () => {
    it('returns { body, etag } with the response ETag header', async () => {
      const body = { id: 'gs-1', value: 'x', version: 7 };
      mockFetch.mockResolvedValueOnce(
        createMockResponse(body, {
          headers: new Headers({
            'content-type': 'application/json',
            etag: '"7"',
          }),
        }),
      );

      const result = await client.getWithEtag<typeof body>('/api/v1/global-settings/gs-1');

      expect(result).toEqual({ body, etag: '"7"' });
      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/api/v1/global-settings/gs-1', expect.objectContaining({ method: 'GET' }));
    });

    it('returns { body, etag: undefined } when the server omits ETag', async () => {
      // Collections and non-versioned resources don't get an ETag
      // (per the ETagInterceptor's defensive checks in D.1). The
      // SDK must surface that as `undefined` so callers can branch
      // on it without checking for "ETag is the empty string."
      const body = { id: 'gs-1', value: 'x' };
      mockFetch.mockResolvedValueOnce(createMockResponse(body));

      const result = await client.getWithEtag<typeof body>('/api/v1/global-settings/gs-1');

      expect(result.body).toEqual(body);
      expect(result.etag).toBeUndefined();
    });

    it('reads ETag case-insensitively (Headers normalize key case)', async () => {
      // The Fetch API spec requires Headers to be case-insensitive,
      // but it's worth pinning because Node's undici, jsdom's
      // polyfill, and browsers have historically diverged on
      // edge cases around HTTP/2 lowercase headers.
      const body = { id: 'gs-2', version: 3 };
      mockFetch.mockResolvedValueOnce(
        createMockResponse(body, {
          headers: new Headers({ ETag: '"3"' }),
        }),
      );

      const result = await client.getWithEtag<typeof body>('/api/v1/global-settings/gs-2');

      expect(result.etag).toBe('"3"');
    });

    it('propagates HTTP errors as AgenticError (same shape as get)', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Not Found'));

      await expect(client.getWithEtag<unknown>('/api/v1/global-settings/missing')).rejects.toBeInstanceOf(AgenticError);
    });
  });

  describe('patchWithIfMatch<T>', () => {
    it('sends the If-Match request header verbatim', async () => {
      const updated = { id: 'gs-1', value: 'y', version: 8 };
      mockFetch.mockResolvedValueOnce(createMockResponse(updated));

      const result = await client.patchWithIfMatch<typeof updated>('/api/v1/global-settings/gs-1', { value: 'y' }, '"7"');

      expect(result).toEqual(updated);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/v1/global-settings/gs-1',
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            'If-Match': '"7"',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ value: 'y' }),
        }),
      );
    });

    it('lifts metadata.currentVersion into AgenticError.context on 412', async () => {
      // The server (Phase C OptimisticConcurrencyExceptionFilter)
      // returns `{ code: 'OCC_CONFLICT', message, metadata: {
      // expectedVersion, currentVersion } }` on 412. The SDK
      // hook (`useGlobalSettings.update`) needs `currentVersion`
      // to build the ConfigConflictError without re-parsing the
      // JSON body, so we lift it into the AgenticError context.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 412,
        statusText: 'Precondition Failed',
        json: () =>
          Promise.resolve({
            code: 'OCC_CONFLICT',
            message: 'Resource changed',
            metadata: { expectedVersion: 7, currentVersion: 9 },
          }),
        text: () => Promise.resolve(''),
        headers: new Headers({ 'content-type': 'application/json' }),
      } as Response);

      let thrown: unknown;
      try {
        await client.patchWithIfMatch<unknown>('/api/v1/global-settings/gs-1', { value: 'y' }, '"7"');
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(AgenticError);
      const err = thrown as AgenticError;
      expect((err.context as Record<string, unknown>).status).toBe(412);
      expect((err.context as Record<string, unknown>).currentVersion).toBe(9);
    });

    it('does NOT add If-Match for unrelated 4xx errors (sanity)', async () => {
      // A 400 from the same endpoint must not have `currentVersion`
      // grafted onto its context — that field is OCC-specific and
      // would be misleading on a generic validation error.
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(400, 'Bad Request'));

      let thrown: unknown;
      try {
        await client.patchWithIfMatch<unknown>('/api/v1/global-settings/gs-1', { value: 'y' }, '"7"');
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(AgenticError);
      const err = thrown as AgenticError;
      expect((err.context as Record<string, unknown>).status).toBe(400);
      expect((err.context as Record<string, unknown>).currentVersion).toBeUndefined();
    });
  });
});
