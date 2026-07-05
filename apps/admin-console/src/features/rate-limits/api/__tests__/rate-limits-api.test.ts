import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRateLimitPolicy, setRateLimitEnabled, setRouteOverride, setTierOverride } from '../client';
import { rateLimitKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function installFetchMock(): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return Response.json({ enabled: true, enabledSource: 'db', tiers: [], routes: [] });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('rateLimitKeys', () => {
    it('exposes a single stable policy key', () => {
        expect(rateLimitKeys.policy()).toEqual(rateLimitKeys.policy());
        expect(rateLimitKeys.policy()[0]).toBe('rate-limits');
    });
});

describe('rate-limits client', () => {
    it('reads the policy and writes kill-switch, tier and route overrides', async () => {
        const calls = installFetchMock();
        await getRateLimitPolicy();
        await setRateLimitEnabled(false);
        await setTierOverride('strict', { limit: 10, ttl: 60_000 });
        await setRouteOverride('user.controller#findAll', { enabled: false });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/rate-limit',
            'PUT /api/hope/admin/rate-limit/enabled',
            'PUT /api/hope/admin/rate-limit/tiers/strict',
            'PUT /api/hope/admin/rate-limit/routes/user.controller%23findAll',
        ]);
        expect(calls[1].body).toEqual({ enabled: false });
        expect(calls[2].body).toEqual({ limit: 10, ttl: 60000 });
        expect(calls[3].body).toEqual({ enabled: false });
    });
});
