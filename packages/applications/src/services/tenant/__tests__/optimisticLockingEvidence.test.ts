/**
 * Phase A evidence test — TASK-302 Stream D.
 *
 * Documents today's silent lost-write behaviour on GlobalSetting writes
 * through TenantService.updateTenantConfigs. The test is committed as
 * `.skip` on purpose:
 *
 *  - With the .skip in place, CI stays green and the test serves as a
 *    canonical, in-tree description of the bug.
 *  - When a developer un-skips locally (and points DATABASE_URL at a
 *    Postgres test DB) the test passes, proving the bug exists.
 *  - Phase C of this plan will delete the `.skip` and invert the assertion:
 *    the second write must throw `OptimisticConcurrencyException`.
 *
 * @see TASK-301 §P2 "missing optimistic locking on config writes"
 * @see docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildTenantServiceTestHarness,
  seedGlobalSetting,
  type TenantServiceTestHarness,
} from './_harness';

describe('Evidence — lost write on GlobalSetting (TASK-301 §P2 / TASK-302 Stream D)', () => {
  let harness: TenantServiceTestHarness;

  beforeEach(async () => {
    harness = await buildTenantServiceTestHarness();
  });

  // SKIPPED ON PURPOSE — documents today's broken behaviour. Phase C will
  // delete this `.skip` and assert the inverse (one write wins, the other
  // throws `OptimisticConcurrencyException`).
  it.skip('two concurrent updateTenantConfigs calls silently overwrite each other', async () => {
    const tenantId = harness.tenantId;
    const setting = await seedGlobalSetting(harness, {
      tenantId,
      key: 'smr-provider-models',
      value: 'v0',
    });

    // Two "tabs" read the same row.
    const tabA = await harness.tenantService.fetchTenantConfigs({
      tenantId,
      limit: 200,
      page: 1,
    });
    const tabB = await harness.tenantService.fetchTenantConfigs({
      tenantId,
      limit: 200,
      page: 1,
    });

    const fromA = tabA.data.find((c) => c.id === setting.id)!;
    const fromB = tabB.data.find((c) => c.id === setting.id)!;
    expect(fromA.value).toBe('v0');
    expect(fromB.value).toBe('v0');

    // Tab A saves first.
    await harness.tenantService.updateTenantConfigs(tenantId, [
      // Pre-Phase-C shape: no `expectedVersion` exists yet.
      { id: fromA.id, value: 'A-wrote-this' } as never,
    ]);

    // Tab B saves second, carrying A's stale value in the rest of the row.
    await harness.tenantService.updateTenantConfigs(tenantId, [
      { id: fromB.id, value: 'B-wrote-this' } as never,
    ]);

    const finalRow = await harness.globalSettingRepository.findById(setting.id);
    // EXPECTED (broken today): B wins, A's write is silently lost.
    expect(finalRow!.value).toBe('B-wrote-this');

    // EXPECTED (broken today): no exception thrown anywhere above.
    // After Phase C this same harness must throw on the second call.
  });
});
