import type { GridLayoutState } from '@arcaai/ui/components/data-grid';
import { describe, expect, it, vi } from 'vitest';
import { createGridLayoutAdapter, type GridSettingsClient } from '../grid-layout-adapter';

const NAMESPACE = 'ui.data-grid';

const layout: GridLayoutState = {
    order: ['username', 'email', 'status'],
    sizing: { username: 180 },
    visibility: { email: false },
    pinning: { left: ['username'], right: [] },
    density: 'compact',
};

describe('createGridLayoutAdapter (D8 grid-layout persistence round-trip)', () => {
    it('save() persists the layout (serialized to a JSON string) under the ui.data-grid namespace + grid key', async () => {
        const updateByKey = vi.fn().mockResolvedValue({});
        const adapter = createGridLayoutAdapter({ list: vi.fn().mockResolvedValue([]), updateByKey });

        await adapter.save(NAMESPACE, 'users', layout);

        // Server contract is `value: string` (validated via JSON.parse), so the
        // adapter must serialize — passing the raw object 400s ("value must be a string").
        expect(updateByKey).toHaveBeenCalledWith(NAMESPACE, 'users', JSON.stringify(layout));
    });

    it('load() returns the layout previously written for the same namespace+key', async () => {
        const store: Array<{ namespace?: string; key: string; value: unknown }> = [];
        const client: GridSettingsClient = {
            list: async () => store,
            updateByKey: async (namespace, key, value) => {
                store.push({ namespace, key, value });
                return {};
            },
        };
        const adapter = createGridLayoutAdapter(client);

        await adapter.save(NAMESPACE, 'users', layout);
        const loaded = await adapter.load(NAMESPACE, 'users');

        expect(loaded).toEqual(layout);
    });

    it('load() parses a server-provided JSON string value (the wire contract)', async () => {
        // Regression: the settings API returns `value` as a JSON string, not an
        // object. The adapter must JSON.parse it — otherwise the layout never
        // restores on refresh (silent best-effort null).
        const adapter = createGridLayoutAdapter({
            list: async () => [{ namespace: NAMESPACE, key: 'users', value: JSON.stringify(layout) }],
            updateByKey: vi.fn(),
        });

        expect(await adapter.load(NAMESPACE, 'users')).toEqual(layout);
    });

    it('load() returns null when no setting matches the key', async () => {
        const adapter = createGridLayoutAdapter({
            list: async () => [{ namespace: NAMESPACE, key: 'tenants', value: JSON.stringify(layout) }],
            updateByKey: vi.fn(),
        });

        expect(await adapter.load(NAMESPACE, 'users')).toBeNull();
    });

    it('load() ignores a matching key stored under a different namespace', async () => {
        const adapter = createGridLayoutAdapter({
            list: async () => [{ namespace: 'some.other.ns', key: 'users', value: JSON.stringify(layout) }],
            updateByKey: vi.fn(),
        });

        expect(await adapter.load(NAMESPACE, 'users')).toBeNull();
    });
});
