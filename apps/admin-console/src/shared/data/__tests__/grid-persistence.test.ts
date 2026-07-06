import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridLayoutState } from '@arcaai/ui';
import { UI_DATA_GRID_MAX_BYTES, UI_DATA_GRID_NAMESPACE, createGridLayoutPersistenceAdapter, invalidateGridLayoutCache } from '../grid-persistence';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

/** Stubs global fetch (the account-api test pattern) and records every call. */
function installFetchMock(response: () => Response = () => Response.json([])): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return response();
        }),
    );
    return calls;
}

const layout: GridLayoutState = {
    order: ['name', 'status', 'createdAt'],
    sizing: { name: 240 },
    visibility: { createdAt: false },
    pinning: { left: ['name'], right: [] },
    density: 'compact',
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('createGridLayoutPersistenceAdapter — load', () => {
    it('GETs user/me/settings and parses the matching ui.data-grid row into GridLayoutState', async () => {
        const calls = installFetchMock(() =>
            Response.json([
                { namespace: 'ui.theme', key: 'tenants', value: '{"noise":true}' },
                { namespace: UI_DATA_GRID_NAMESPACE, key: 'other-grid', value: '{"nope":true}' },
                { namespace: UI_DATA_GRID_NAMESPACE, key: 'tenants', value: JSON.stringify(layout) },
            ]),
        );
        const adapter = createGridLayoutPersistenceAdapter();

        const result = await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants');

        expect(calls).toHaveLength(1);
        expect(`${calls[0].method} ${calls[0].url}`).toBe('GET /api/hope/user/me/settings');
        expect(result).toEqual(layout);
    });

    it('returns null when there is no matching row (miss)', async () => {
        installFetchMock(() => Response.json([{ namespace: UI_DATA_GRID_NAMESPACE, key: 'users', value: JSON.stringify(layout) }]));
        const adapter = createGridLayoutPersistenceAdapter();

        expect(await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants')).toBeNull();
    });

    it('returns null (never throws) when the stored value is not valid JSON', async () => {
        installFetchMock(() => Response.json([{ namespace: UI_DATA_GRID_NAMESPACE, key: 'tenants', value: 'definitely-not-json' }]));
        const adapter = createGridLayoutPersistenceAdapter();

        expect(await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants')).toBeNull();
    });

    it('returns null (never throws) when the request fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('network down');
            }),
        );
        const adapter = createGridLayoutPersistenceAdapter();

        await expect(adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants')).resolves.toBeNull();
    });
});

describe('createGridLayoutPersistenceAdapter — request dedup & cache (TASK-428)', () => {
    it('shares one GET across concurrent loads (N grids on one page)', async () => {
        const calls = installFetchMock(() => Response.json([{ namespace: UI_DATA_GRID_NAMESPACE, key: 'tenants', value: JSON.stringify(layout) }]));
        const adapter = createGridLayoutPersistenceAdapter();

        const [tenants, users] = await Promise.all([
            adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants'),
            adapter.load(UI_DATA_GRID_NAMESPACE, 'users'),
        ]);

        expect(calls).toHaveLength(1);
        expect(tenants).toEqual(layout);
        expect(users).toBeNull();
    });

    it('serves loads within the TTL from cache and refetches after expiry', async () => {
        vi.useFakeTimers();
        try {
            const calls = installFetchMock(() => Response.json([]));
            const adapter = createGridLayoutPersistenceAdapter();

            await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants');
            await adapter.load(UI_DATA_GRID_NAMESPACE, 'users');
            expect(calls).toHaveLength(1);

            vi.advanceTimersByTime(30_001);
            await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants');
            expect(calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a successful save invalidates the cache so the next load refetches', async () => {
        const calls = installFetchMock(() => Response.json([]));
        const adapter = createGridLayoutPersistenceAdapter();

        await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants');
        await adapter.save(UI_DATA_GRID_NAMESPACE, 'tenants', layout);
        await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants');

        expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET']);
    });

    it('invalidateGridLayoutCache drops the SHARED adapter cache (identity change: impersonation)', async () => {
        // The shared singleton is module state; exercise it through the exported
        // invalidator the session flows call alongside queryClient.invalidateQueries().
        const { sharedGridLayoutPersistence } = await import('../grid-persistence');
        const calls = installFetchMock(() => Response.json([]));

        await sharedGridLayoutPersistence.load(UI_DATA_GRID_NAMESPACE, 'tenants');
        invalidateGridLayoutCache();
        await sharedGridLayoutPersistence.load(UI_DATA_GRID_NAMESPACE, 'tenants');

        expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    });

    it('does not cache a failed load — the next load retries', async () => {
        let attempts = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('network down');
                return Response.json([{ namespace: UI_DATA_GRID_NAMESPACE, key: 'tenants', value: JSON.stringify(layout) }]);
            }),
        );
        const adapter = createGridLayoutPersistenceAdapter();

        expect(await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants')).toBeNull();
        expect(await adapter.load(UI_DATA_GRID_NAMESPACE, 'tenants')).toEqual(layout);
        expect(attempts).toBe(2);
    });
});

describe('createGridLayoutPersistenceAdapter — save', () => {
    it('PATCHes user/me/settings/<namespace>/<gridId> with a JSON-stringified value body', async () => {
        const calls = installFetchMock(() => Response.json({}));
        const adapter = createGridLayoutPersistenceAdapter();

        await adapter.save(UI_DATA_GRID_NAMESPACE, 'tenants', layout);

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].url).toBe('/api/hope/user/me/settings/ui.data-grid/tenants');
        expect(calls[0].body).toEqual({ value: JSON.stringify(layout) });
    });

    it('skips the save (no request) and warns once when the serialized value exceeds 16KB', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const calls = installFetchMock(() => Response.json({}));
        const adapter = createGridLayoutPersistenceAdapter();

        const oversized: GridLayoutState = {
            ...layout,
            order: Array.from({ length: 2000 }, (_, i) => `col_${i}_${'x'.repeat(16)}`),
        };
        expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(UI_DATA_GRID_MAX_BYTES);

        await adapter.save(UI_DATA_GRID_NAMESPACE, 'tenants', oversized);
        await adapter.save(UI_DATA_GRID_NAMESPACE, 'tenants', oversized);

        expect(calls).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('is best-effort: swallows request errors and never rejects', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('boom', { status: 500 })),
        );
        const adapter = createGridLayoutPersistenceAdapter();

        await expect(adapter.save(UI_DATA_GRID_NAMESPACE, 'tenants', layout)).resolves.toBeUndefined();
    });
});
