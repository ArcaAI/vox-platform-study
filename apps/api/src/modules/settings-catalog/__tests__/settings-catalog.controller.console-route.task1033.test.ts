import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService, PlatformStorageSettingsResolver } from '@arcaai/applications';
import { SettingsCatalogController } from '../settings-catalog.controller';

// TASK-1033 — the catalog item names the console screen that owns a dedicated-surface write
// (`consoleRoute` / `consoleRouteLabel`) and, for `db-config` keys, the value the dedicated row
// actually stores (`dedicatedRow`) — fixing the false "code default · no row stored".

function controllerFor(dedicated: Record<string, { value: unknown; version: number }>) {
  const cls = { get: (k: string) => (k === 'user' ? { roles: ['SUPER_ADMIN'] } : undefined) } as never;
  const resolver = { dedicatedRowValues: vi.fn(async () => dedicated) } as unknown as PlatformStorageSettingsResolver;
  return { controller: new SettingsCatalogController(cls, {} as EffectiveSettingsService, resolver), resolver };
}

describe('SettingsCatalogController.getCatalog — TASK-1033', () => {
  it('reports consoleRoute + dedicatedRow for a storage.platformDefault key the SYSTEM row sets', async () => {
    const { controller, resolver } = controllerFor({ 'storage.platformDefault.publicEndpoint': { value: 'https://admin.example.com', version: 7 } });
    const res = await controller.getCatalog();
    const item = res.items.find((i) => i.key === 'storage.platformDefault.publicEndpoint')!;
    expect(item.consoleRoute).toBe('/tenants/storage?tab=configs');
    expect(item.consoleRouteLabel).toBe('Tenant storage');
    expect(item.dedicatedRow).toEqual({ value: 'https://admin.example.com', version: 7 });
    // one row read for the whole catalog, not one per key
    expect(resolver.dedicatedRowValues).toHaveBeenCalledTimes(1);
  });

  it('dedicatedRow is null for a db-config key the row leaves unset', async () => {
    const { controller } = controllerFor({});
    const item = (await controller.getCatalog()).items.find((i) => i.key === 'storage.platformDefault.region')!;
    expect(item.dedicatedRow).toBeNull();
    expect(item.consoleRoute).toBe('/tenants/storage?tab=configs');
  });

  it('entitlement keys route to /entitlements; global-kv / env / vault-kv carry null route and null dedicatedRow', async () => {
    const { controller } = controllerFor({});
    const items = (await controller.getCatalog()).items;
    const ent = items.find((i) => i.key === 'entitlements.featurePlatformDefaultCredential')!;
    expect(ent.consoleRoute).toBe('/entitlements');
    expect(ent.consoleRouteLabel).toBe('Entitlements');
    expect(ent.dedicatedRow).toBeNull();
    for (const tier of ['global-kv', 'env', 'vault-kv']) {
      const item = items.find((i) => i.tier === tier)!;
      expect(item, tier).toBeDefined();
      expect(item.consoleRoute).toBeNull();
      expect(item.consoleRouteLabel).toBeNull();
      expect(item.dedicatedRow).toBeNull();
    }
  });
});
