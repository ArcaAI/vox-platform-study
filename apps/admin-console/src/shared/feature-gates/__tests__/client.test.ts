import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveFeatureGates } from '../client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getEffectiveFeatureGates', () => {
  it('folds the items array into a key -> value map, dropping sourceScope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe('/api/hope/admin/settings/features/effective');
        return Response.json({
          items: [
            { key: 'console.tools.mcp.enabled', value: true, sourceScope: 'tenant' },
            { key: 'console.mlflow.enabled', value: false, sourceScope: 'system' },
          ],
        });
      }),
    );

    expect(await getEffectiveFeatureGates()).toEqual({
      'console.tools.mcp.enabled': true,
      'console.mlflow.enabled': false,
    });
  });

  it('returns an empty map for an empty items array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })));
    expect(await getEffectiveFeatureGates()).toEqual({});
  });

  it('throws GatewayError on a non-2xx response — the hook, not the client, absorbs it into an empty map', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })));
    await expect(getEffectiveFeatureGates()).rejects.toMatchObject({ status: 404 });
  });
});
