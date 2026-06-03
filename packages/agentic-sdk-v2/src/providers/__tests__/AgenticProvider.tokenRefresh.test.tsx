/**
 * AgenticProvider — auto-wired token refresh (TASK-320 B2)
 *
 * `AgenticClient` already had a 401→refresh-once mutex
 * (`deduplicatedRefresh`/`setOnUnauthorized`), but nothing in the SDK ever
 * registered a handler, so auto-refresh was inert. B2 wires it inside the
 * provider so refresh works out of the box.
 *
 * These tests drive the REAL `AgenticClient` owned by the provider (captured
 * via `useStoreApi()`), with `global.fetch` mocked, and assert the end-to-end
 * behaviour:
 *   - a 401 on a normal request triggers EXACTLY one refresh + one retry, and
 *     the retry carries the refreshed bearer token;
 *   - a failed refresh propagates the original 401 (no extra retry);
 *   - refresh is skipped during impersonation (admin session not clobbered);
 *   - the `/auth/refresh` endpoint never recurses into another refresh;
 *   - the handler is registered ONCE per client (idempotent across re-renders).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { AgenticProvider } from '../AgenticProvider';
import { AgenticClient } from '../../core/AgenticClient';
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig } from '../../types';
import { mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';

let capturedStore: AgenticStoreApi | null = null;
function StoreProbe() {
    capturedStore = useStoreApi();
    return null;
}

const testConfig: AgenticConfig = {
    api: {
        baseUrl: 'http://test-api.com',
        // NOTE: intentionally NO static accessToken — B2 must work for SDK-driven
        // auth where useAuth.login sets the token, not a host-managed prop.
        tenantId: 'test-tenant',
    },
    audio: { noiseFilter: false, vad: false, stt: false },
    personalization: { storage: 'local', defaults: { language: 'en' } },
    logging: { level: 'error' },
};

/** Render the provider and resolve once its AgenticClient is initialized. */
async function renderInitializedProvider(): Promise<AgenticClient> {
    render(
        <AgenticProvider config={testConfig}>
            <StoreProbe />
        </AgenticProvider>,
    );
    await waitFor(() => {
        expect(capturedStore).not.toBeNull();
        expect(capturedStore!.getState().initialized).toBe(true);
        expect(capturedStore!.getState().apiClient).toBeDefined();
    });
    // Let any trailing init re-renders / effects settle so the sync block has
    // run and won't fire again during the assertions below.
    await new Promise((r) => setTimeout(r, 0));
    return capturedStore!.getState().apiClient as AgenticClient;
}

describe('AgenticProvider — TASK-320 B2 auto-wired token refresh', () => {
    beforeEach(() => {
        capturedStore = null;
        mockFetch.mockReset();
        // Default: everything succeeds (covers provider initialization fetches).
        mockFetch.mockResolvedValue(createMockResponse([]));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('refreshes once and retries once when a normal request returns 401', async () => {
        const apiClient = await renderInitializedProvider();

        let probeCalls = 0;
        let refreshCalls = 0;
        const fetchArgs: Array<[string, RequestInit]> = [];
        mockFetch.mockImplementation((url: string, init: RequestInit = {}) => {
            const u = String(url);
            fetchArgs.push([u, init]);
            if (u.includes('/auth/refresh')) {
                refreshCalls += 1;
                return Promise.resolve(
                    createMockResponse({ token: 'new-access', refreshToken: 'rotated-refresh' }),
                );
            }
            if (u.includes('/b2-probe')) {
                probeCalls += 1;
                if (probeCalls === 1) return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
                return Promise.resolve(createMockResponse({ ok: true }));
            }
            return Promise.resolve(createMockResponse([]));
        });

        // The refresh token is the ONLY thing the handler needs — it lives in the
        // AgenticClient WeakMap (not touched by the provider sync block).
        apiClient.setRefreshToken('initial-refresh');

        const result = await apiClient.get<{ ok: boolean }>('/b2-probe');

        expect(result).toEqual({ ok: true });
        expect(refreshCalls).toBe(1); // exactly one refresh
        expect(probeCalls).toBe(2); // original 401 + one retry

        // The retry must carry the refreshed bearer token.
        const retryCall = fetchArgs.find(([u], i) => u.includes('/b2-probe') && i > 0 && fetchArgs[i - 1][0].includes('/auth/refresh'));
        expect(retryCall).toBeDefined();
        expect((retryCall![1].headers as Record<string, string>)['Authorization']).toBe('Bearer new-access');

        // The single-use refresh token was rotated in memory for the next 401.
        expect(apiClient.getRefreshToken()).toBe('rotated-refresh');
    });

    it('propagates the original 401 when the refresh fails (no extra retry)', async () => {
        const apiClient = await renderInitializedProvider();

        let probeCalls = 0;
        let refreshCalls = 0;
        mockFetch.mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes('/auth/refresh')) {
                refreshCalls += 1;
                // Expired/invalid refresh token — backend rejects.
                return Promise.resolve(createMockErrorResponse(401, 'Refresh token expired'));
            }
            if (u.includes('/b2-fail')) {
                probeCalls += 1;
                return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
            }
            return Promise.resolve(createMockResponse([]));
        });

        apiClient.setRefreshToken('initial-refresh');

        await expect(apiClient.get('/b2-fail')).rejects.toMatchObject({
            context: expect.objectContaining({ status: 401 }),
        });

        expect(refreshCalls).toBe(1); // attempted exactly once
        expect(probeCalls).toBe(1); // original request NOT retried after failed refresh
    });

    it('does not attempt a refresh when no refresh token is held', async () => {
        const apiClient = await renderInitializedProvider();

        let refreshCalls = 0;
        mockFetch.mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes('/auth/refresh')) {
                refreshCalls += 1;
                return Promise.resolve(createMockResponse({ token: 'x' }));
            }
            if (u.includes('/b2-noref')) {
                return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
            }
            return Promise.resolve(createMockResponse([]));
        });

        // No setRefreshToken — handler must short-circuit and return false.
        apiClient.clearRefreshToken();

        await expect(apiClient.get('/b2-noref')).rejects.toMatchObject({
            context: expect.objectContaining({ status: 401 }),
        });
        expect(refreshCalls).toBe(0);
    });

    it('skips refresh during impersonation so the admin session is not clobbered', async () => {
        const apiClient = await renderInitializedProvider();

        let refreshCalls = 0;
        mockFetch.mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes('/auth/refresh')) {
                refreshCalls += 1;
                return Promise.resolve(createMockResponse({ token: 'should-not-happen' }));
            }
            if (u.includes('/b2-imp')) {
                return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
            }
            return Promise.resolve(createMockResponse([]));
        });

        apiClient.setRefreshToken('admin-refresh');
        apiClient.startImpersonation('admin-original-jwt'); // isImpersonating() === true

        await expect(apiClient.get('/b2-imp')).rejects.toMatchObject({
            context: expect.objectContaining({ status: 401 }),
        });

        expect(refreshCalls).toBe(0); // refresh skipped while impersonating
        expect(apiClient.isImpersonating()).toBe(true); // impersonation state intact
    });

    it('does not recurse: a 401 from /auth/refresh itself triggers no further refresh', async () => {
        const apiClient = await renderInitializedProvider();

        let refreshCalls = 0;
        mockFetch.mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes('/auth/refresh')) {
                refreshCalls += 1;
                return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
            }
            if (u.includes('/b2-recurse')) {
                return Promise.resolve(createMockErrorResponse(401, 'Unauthorized'));
            }
            return Promise.resolve(createMockResponse([]));
        });

        apiClient.setRefreshToken('initial-refresh');

        await expect(apiClient.get('/b2-recurse')).rejects.toMatchObject({
            context: expect.objectContaining({ status: 401 }),
        });

        // /auth/refresh is in REFRESH_SKIP_ENDPOINTS: its own 401 must NOT spawn
        // another refresh, so the handler is entered exactly once.
        expect(refreshCalls).toBe(1);
    });

    it('registers the onUnauthorized handler exactly once, even across re-renders', async () => {
        const setOnUnauthorizedSpy = vi.spyOn(AgenticClient.prototype, 'setOnUnauthorized');

        const { rerender } = render(
            <AgenticProvider config={testConfig}>
                <StoreProbe />
            </AgenticProvider>,
        );

        await waitFor(() => {
            expect(capturedStore?.getState().apiClient).toBeDefined();
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(setOnUnauthorizedSpy).toHaveBeenCalledTimes(1);

        // Re-render with identical config a few times — the guarded effect keyed
        // on the client instance must NOT re-register.
        rerender(
            <AgenticProvider config={testConfig}>
                <StoreProbe />
            </AgenticProvider>,
        );
        rerender(
            <AgenticProvider config={testConfig}>
                <StoreProbe />
            </AgenticProvider>,
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(setOnUnauthorizedSpy).toHaveBeenCalledTimes(1);
    });

    // TASK-331 doc-05 F-5 — a host that owns its own 401 handling (e.g. the
    // ui-playground's impersonation-aware `useAutoRefresh`) can opt OUT of the
    // provider's default auto-wire so the single-slot `setOnUnauthorized` has a
    // deterministic owner. Default (undefined / true) preserves B2 behaviour.
    it('does NOT auto-wire setOnUnauthorized when autoWireTokenRefresh is false (F-5)', async () => {
        const setOnUnauthorizedSpy = vi.spyOn(AgenticClient.prototype, 'setOnUnauthorized');

        render(
            <AgenticProvider config={{ ...testConfig, autoWireTokenRefresh: false }}>
                <StoreProbe />
            </AgenticProvider>,
        );

        await waitFor(() => {
            expect(capturedStore?.getState().apiClient).toBeDefined();
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(setOnUnauthorizedSpy).not.toHaveBeenCalled();
    });

    it('auto-wires setOnUnauthorized exactly once when autoWireTokenRefresh is explicitly true (F-5)', async () => {
        const setOnUnauthorizedSpy = vi.spyOn(AgenticClient.prototype, 'setOnUnauthorized');

        render(
            <AgenticProvider config={{ ...testConfig, autoWireTokenRefresh: true }}>
                <StoreProbe />
            </AgenticProvider>,
        );

        await waitFor(() => {
            expect(capturedStore?.getState().apiClient).toBeDefined();
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(setOnUnauthorizedSpy).toHaveBeenCalledTimes(1);
    });
});
