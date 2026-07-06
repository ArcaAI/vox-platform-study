import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridLayoutState } from '@arcaai/ui';
import { UI_DATA_GRID_MAX_BYTES, UI_DATA_GRID_NAMESPACE, createGridLayoutPersistenceAdapter } from '../grid-persistence';

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
