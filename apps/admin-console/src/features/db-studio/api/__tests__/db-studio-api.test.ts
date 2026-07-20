import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPstudioStatus } from '../client';
import { dbStudioKeys } from '../keys';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('pstudio', () => {
    it('has a stable status key under its own namespace', () => {
        expect(dbStudioKeys.status()).toEqual(dbStudioKeys.status());
        expect(dbStudioKeys.status()[0]).toBe('pstudio');
    });

    it('reads the production-gated status endpoint', async () => {
        const fetchMock = vi.fn(async () => Response.json({ enabled: false }));
        vi.stubGlobal('fetch', fetchMock);
        const status = await getPstudioStatus();
        expect(fetchMock).toHaveBeenCalledWith('/api/hope/admin/pstudio/status', expect.anything());
        expect(status.enabled).toBe(false);
    });
});
