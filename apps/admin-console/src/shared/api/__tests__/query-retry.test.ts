/**
 * TASK-428 — app-wide TanStack Query retry policy. A 4xx is deterministic
 * (the retry replays the same failure, doubling request count — dev-log
 * evidence: tenant/me, entitlements/me, rbac/roles each fired twice with
 * 400s), so only network errors and 5xx get the single retry. 401 is also
 * excluded: the BFF proxy already does its own single-flight refresh+retry.
 */

import { describe, expect, it } from 'vitest';
import { GatewayError } from '../http';
import { retryQuery } from '../query-retry';

describe('retryQuery', () => {
    it.each([400, 401, 403, 404, 412, 428])('never retries a GatewayError %i', (status) => {
        expect(retryQuery(0, new GatewayError(status, 'client error'))).toBe(false);
    });

    it.each([500, 502, 503])('retries a GatewayError %i once', (status) => {
        expect(retryQuery(0, new GatewayError(status, 'server error'))).toBe(true);
        expect(retryQuery(1, new GatewayError(status, 'server error'))).toBe(false);
    });

    it('retries a non-gateway error (network failure) once', () => {
        expect(retryQuery(0, new Error('fetch failed'))).toBe(true);
        expect(retryQuery(1, new Error('fetch failed'))).toBe(false);
    });
});
