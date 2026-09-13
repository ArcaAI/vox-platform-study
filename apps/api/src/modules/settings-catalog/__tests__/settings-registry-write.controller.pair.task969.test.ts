/**
 * TASK-969 WS-1 step 3 — one call returns BOTH halves of a paired key.
 *
 * `text.guardrailPolicy.<f>` (tenant, PUSH) and `text.externalGuardrail.<f>`
 * (platform, PULL) are two keys for TRANSPORT reasons, and since owner decision
 * OD-2 both are `globalOnly` — one audience, the platform admin. So the split
 * has no business surfacing as two console rows, and the console cannot collapse
 * them without being told the platform half's value in the same response it uses
 * to render the tenant half.
 *
 * `pair` is that block, and it is a CONTRACT — the console lane builds against
 * this exact shape. It is absent for every key that does not declare
 * `platformTierKey`, which is all but two of 242.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService, SettingsRegistryWriteService } from '@arcaai/applications';
import { SettingsRegistryWriteController } from '../settings-registry-write.controller';

const TENANT_HALF = 'text.guardrailPolicy.requireMedical';
const PLATFORM_TWIN = 'text.externalGuardrail.requireMedical';
/** No `platformTierKey` — must carry no `pair` block at all. */
const UNPAIRED_KEY = 'rateLimit.maxRequests';

const superAdmin = { roles: ['SUPER_ADMIN'] };

function controllerFor(opts: {
  /** `key` → what the cascade resolves for it. */
  resolved?: Record<string, { value: unknown; sourceScope: string }>;
  /** `key`+scope → backing row version. */
  versions?: Record<string, number>;
} = {}) {
  const cls = { get: (k: string) => (k === 'user' ? superAdmin : undefined) } as never;
  const effective = {
    resolveEffective: vi.fn(async (key: string) => ({
      key,
      tier: 'global-kv',
      value: opts.resolved?.[key]?.value ?? null,
      sourceScope: opts.resolved?.[key]?.sourceScope ?? 'code-default',
    })),
  } as unknown as EffectiveSettingsService;
  const write = {
    getBackingRowVersion: vi.fn(async (key: string) => opts.versions?.[key] ?? 0),
  } as unknown as SettingsRegistryWriteService;
  return { controller: new SettingsRegistryWriteController(cls, effective, write), effective, write };
}

describe('GET registry/:key — the `pair` block', () => {
  it('returns the contract shape for the tenant half, with the platform value beside it', async () => {
    const { controller } = controllerFor({
      resolved: {
        [TENANT_HALF]: { value: false, sourceScope: 'tenant' },
        [PLATFORM_TWIN]: { value: true, sourceScope: 'system' },
      },
      versions: { [TENANT_HALF]: 3, [PLATFORM_TWIN]: 2 },
    });

    const res = await controller.getSetting(TENANT_HALF, 'tnt-1', undefined, undefined, 'tenant');

    expect(res).toMatchObject({ key: TENANT_HALF, value: false, sourceScope: 'tenant', version: 3 });
    expect(res.pair).toEqual({
      platformTierKey: PLATFORM_TWIN,
      platformValue: true,
      platformVersion: 2,
      inForce: 'tenant',
    });
  });

  it('reports inForce `platform` when NO tenant row exists — the runtime predicate, mirrored', async () => {
    // `applyTenantGuardrailPolicy` pushes only on `sourceScope === 'tenant'`.
    // A SYSTEM row on the tenant half is exactly the dead write this ticket
    // removes, so it must NOT read as in force.
    const { controller } = controllerFor({
      resolved: {
        [TENANT_HALF]: { value: false, sourceScope: 'system' },
        [PLATFORM_TWIN]: { value: true, sourceScope: 'system' },
      },
      versions: { [PLATFORM_TWIN]: 2 },
    });

    const res = await controller.getSetting(TENANT_HALF);

    expect(res.pair?.inForce).toBe('platform');
    expect(res.pair?.platformValue).toBe(true);
  });

  it('reads the platform version from the SYSTEM row, never the scope the caller asked for', async () => {
    const { controller, write } = controllerFor({ versions: { [PLATFORM_TWIN]: 7 } });

    await controller.getSetting(TENANT_HALF, 'tnt-1', undefined, undefined, 'tenant');

    expect(write.getBackingRowVersion).toHaveBeenCalledWith(TENANT_HALF, 'tenant');
    expect(write.getBackingRowVersion).toHaveBeenCalledWith(PLATFORM_TWIN, 'system');
  });

  it('omits `pair` entirely for a key that declares no platform tier', async () => {
    const { controller, effective } = controllerFor();

    const res = await controller.getSetting(UNPAIRED_KEY);

    expect(res.pair).toBeUndefined();
    expect('pair' in res).toBe(false);
    // and it costs no extra resolution — one key, one cascade read.
    expect(effective.resolveEffective).toHaveBeenCalledTimes(1);
  });
});
