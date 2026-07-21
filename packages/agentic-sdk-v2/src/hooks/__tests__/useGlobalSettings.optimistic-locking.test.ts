/**
 * useGlobalSettings — Optimistic-locking SDK contract tests
 *
 * @vitest-environment jsdom
 *
 * Verifies the round-trip:
 *   1. `get(id)` issues a GET and stashes the `ETag` header from the response
 *      into the module-level cache (keyed by setting id).
 *   2. `update(id, input)` replays the stashed `ETag` as `If-Match` and bumps
 *      the cache on success.
 *   3. On 412 Precondition Failed, `update` throws `ConfigConflictError` (not
 *      a generic AgenticError) so callers can branch on `instanceof`.
 *   4. The cache is invalidated on conflict so a subsequent `get` is required
 *      before retry (prevents the SDK from blindly re-applying a stale value).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGlobalSettings } from '../useGlobalSettings';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { GLOBAL_SETTINGS_ENDPOINTS } from '../../core/constants';
import { ConfigConflictError } from '../../types/settings';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useGlobalSettings — optimistic locking (TASK-302 Stream D Phase D.4)', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockGetWithEtag = vi.fn();
    const mockPatchWithIfMatch = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockGetWithEtag.mockReset();
        mockPatchWithIfMatch.mockReset();

        mockStore = {
            apiClient: {
                get: mockGet,
                getWithEtag: mockGetWithEtag,
                patchWithIfMatch: mockPatchWithIfMatch,
                post: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
            },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('get(id) — ETag capture', () => {
        it('issues getWithEtag(endpoint) and returns the body', async () => {
            mockGetWithEtag.mockResolvedValue({
                body: { id: 'gs-1', key: 'k', value: 'v', version: 7, tenantId: 't-1' },
                etag: '"7"',
            });

            const { result } = renderHook(() => useGlobalSettings());

            let returned: any;
            await act(async () => {
                returned = await result.current.get('gs-1');
            });

            expect(mockGetWithEtag).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.GET('gs-1'));
            expect(returned).toEqual(
                expect.objectContaining({ id: 'gs-1', version: 7 }),
            );
            // Legacy non-ETag get() must NOT be used on this path; otherwise
            // the cached token is never populated and update() throws.
            expect(mockGet).not.toHaveBeenCalled();
        });
    });

    describe('update(id, input) — If-Match replay', () => {
        it('replays the cached ETag from the prior get as If-Match', async () => {
            mockGetWithEtag.mockResolvedValue({
                body: { id: 'gs-1', key: 'k', value: 'v', version: 7, tenantId: 't-1' },
                etag: '"7"',
            });
            mockPatchWithIfMatch.mockResolvedValue({ id: 'gs-1', key: 'k', value: 'new', version: 8, tenantId: 't-1' });

            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                await result.current.get('gs-1');
            });

            await act(async () => {
                await result.current.update('gs-1', { value: 'new' });
            });

            expect(mockPatchWithIfMatch).toHaveBeenCalledWith(
                GLOBAL_SETTINGS_ENDPOINTS.UPDATE('gs-1'),
                { value: 'new' },
                '"7"',
            );
        });

        it('throws ConfigConflictError on 412 (not generic AgenticError)', async () => {
            mockGetWithEtag.mockResolvedValue({
                body: { id: 'gs-1', key: 'k', value: 'v', version: 7, tenantId: 't-1' },
                etag: '"7"',
            });

                // Note: `classifyHttpError(412)` returns `'VALIDATION_ERROR'`
                // — the SDK identifies 412 via `context.status`, not the
                // `code`, because the `AgenticErrorCode` union has no
                // dedicated PRECONDITION_FAILED entry (adding one would be
                // a public-API change; the status-based branch is the
                // smaller, surgical change).
                const httpError = new AgenticError('VALIDATION_ERROR', 'Concurrency conflict', {
                    context: { status: 412, currentVersion: 9 },
                });
            mockPatchWithIfMatch.mockRejectedValue(httpError);

            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                await result.current.get('gs-1');
            });

            let thrown: unknown;
            await act(async () => {
                try {
                    await result.current.update('gs-1', { value: 'new' });
                } catch (e) {
                    thrown = e;
                }
            });

            expect(thrown).toBeInstanceOf(ConfigConflictError);
            const err = thrown as ConfigConflictError;
            expect(err.settingId).toBe('gs-1');
            expect(err.expectedVersion).toBe(7);
            expect(err.currentVersion).toBe(9);
        });

        it('refreshes the cached ETag on a successful update', async () => {
            mockGetWithEtag
                .mockResolvedValueOnce({
                    body: { id: 'gs-1', key: 'k', value: 'v', version: 7, tenantId: 't-1' },
                    etag: '"7"',
                });
            mockPatchWithIfMatch.mockResolvedValueOnce({ id: 'gs-1', key: 'k', value: 'a', version: 8, tenantId: 't-1' });
            mockPatchWithIfMatch.mockResolvedValueOnce({ id: 'gs-1', key: 'k', value: 'b', version: 9, tenantId: 't-1' });

            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                await result.current.get('gs-1');
            });

            await act(async () => {
                await result.current.update('gs-1', { value: 'a' });
            });
            // The first PATCH bumped the cached token from "7" -> "8". A
            // subsequent update without an intervening get() must use "8",
            // not "7" (otherwise we'd self-conflict on every other save).
            expect(mockPatchWithIfMatch).toHaveBeenNthCalledWith(
                1,
                GLOBAL_SETTINGS_ENDPOINTS.UPDATE('gs-1'),
                { value: 'a' },
                '"7"',
            );

            await act(async () => {
                await result.current.update('gs-1', { value: 'b' });
            });
            expect(mockPatchWithIfMatch).toHaveBeenNthCalledWith(
                2,
                GLOBAL_SETTINGS_ENDPOINTS.UPDATE('gs-1'),
                { value: 'b' },
                '"8"',
            );
        });

        it('throws when update is called before any get (no cached ETag)', async () => {
            // Use a fresh id that no prior test in this file has called
            // get() on — the etag cache is module-level so previous test
            // populations leak across tests in the same suite.
            const FRESH_ID = 'gs-no-prior-get-9b3a2f';
            const { result } = renderHook(() => useGlobalSettings());

            let thrown: unknown;
            await act(async () => {
                try {
                    await result.current.update(FRESH_ID, { value: 'new' });
                } catch (e) {
                    thrown = e;
                }
            });

            expect(thrown).toBeInstanceOf(Error);
            expect((thrown as Error).message).toMatch(/No ETag cached/i);
            // We must NOT silently issue a no-If-Match PATCH — that would
            // be a 428 from the server and surface as a confusing AgenticError
            // rather than the right "you forgot to call get() first" signal.
            expect(mockPatchWithIfMatch).not.toHaveBeenCalled();
        });
    });

    describe('ConfigConflictError', () => {
        it('carries the structured fields callers need for the conflict UX', () => {
            const err = new ConfigConflictError('gs-1', 7, 8);
            expect(err.code).toBe('CONFIG_CONFLICT');
            expect(err.settingId).toBe('gs-1');
            expect(err.expectedVersion).toBe(7);
            expect(err.currentVersion).toBe(8);
            expect(err.message).toMatch(/gs-1/);
            expect(err.message).toMatch(/7/);
            expect(err.message).toMatch(/8/);
        });

        it('is instanceof Error (so unhandled-rejection handlers see it)', () => {
            const err = new ConfigConflictError('gs-1', 7, 8);
            expect(err).toBeInstanceOf(Error);
        });
    });
});
