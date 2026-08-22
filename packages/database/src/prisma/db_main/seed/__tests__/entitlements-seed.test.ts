/**
 * seedEntitlements — addition.
 *
 * Two GlobalSetting kill-switches seed off the SAME resolution:
 *   - `entitlements.enabled`        (ENTITLEMENTS_ENABLED_DEFAULT)   — pre-existing (WS-A)
 *   - `metering.reconcile.enabled`  (METERING_RECONCILE_ENABLED_DEFAULT) — new
 *
 * Both resolve at MODULE LOAD TIME to the value of a FRESH row only (`create`
 * branch): an explicit `*_DEFAULT` env var wins in either direction, and when
 * unset the value is DERIVED — ON in a deployed (host-env-only) environment,
 * OFF on a laptop and in test/CI. An existing row's `update` branch never
 * touches `value`, so a re-seed can never clobber a live operator toggle
 * (OQ3). `vi.resetModules()` + dynamic import per test is required because the
 * resolution happens once, at import — mirrors `phi-encryption.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_GLOBAL_SETTING_IDS, SYSTEM_TENANT_ID } from '../00-constants';
import { PLAN_ENTITLEMENTS } from '../15-entitlements';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('ENTITLEMENTS_ENABLED_DEFAULT', '');
  vi.stubEnv('METERING_RECONCILE_ENABLED_DEFAULT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../../../../env');
});

async function loadSeedEntitlements() {
  return (await import('../15-entitlements')).seedEntitlements;
}

function makeMockClient() {
  const upserts: Array<{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }> = [];
  const client = {
    planEntitlement: { upsert: vi.fn(async () => ({})) },
    globalSetting: {
      upsert: vi.fn(async (args: { where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        upserts.push(args);
        return {};
      }),
    },
  };
  return { client, upserts };
}

describe('seedEntitlements — metering.reconcile.enabled GlobalSetting row', () => {
  it('upserts a SECOND kill-switch row (metering.reconcile.enabled) alongside entitlements.enabled', async () => {
    const seedEntitlements = await loadSeedEntitlements();
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    const meteringUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled');
    expect(meteringUpsert).toBeDefined();
    expect(meteringUpsert!.create).toMatchObject({
      id: SEED_GLOBAL_SETTING_IDS.METERING_RECONCILE_ENABLED,
      tenantId: SYSTEM_TENANT_ID,
      namespace: 'metering',
      key: 'metering.reconcile.enabled',
      defaultValue: 'false',
    });
  });

  it('defaults the metering.reconcile.enabled FRESH-row value to false when METERING_RECONCILE_ENABLED_DEFAULT is unset (TEST/CI/PROD posture)', async () => {
    const seedEntitlements = await loadSeedEntitlements();
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    const meteringUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!;
    expect(meteringUpsert.create.value).toBe('false');
  });

  it('defaults the metering.reconcile.enabled FRESH-row value to true when METERING_RECONCILE_ENABLED_DEFAULT is truthy (DEV/STAGING posture)', async () => {
    vi.stubEnv('METERING_RECONCILE_ENABLED_DEFAULT', 'true');
    const seedEntitlements = await loadSeedEntitlements();
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    const meteringUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!;
    expect(meteringUpsert.create.value).toBe('true');
  });

  it('never overwrites an EXISTING row value on re-seed (update branch omits `value`)', async () => {
    vi.stubEnv('METERING_RECONCILE_ENABLED_DEFAULT', 'true'); // would flip a fresh row ON…
    const seedEntitlements = await loadSeedEntitlements();
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    const meteringUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!;
    // …but the `update` branch (applied on re-seed) must not carry `value` at
    // all, so an operator's live toggle is never clobbered.
    expect(meteringUpsert.update).not.toHaveProperty('value');
  });

  /**
   * The fresh-row default is DERIVED, not stamped: unset ⇒ ON in a deployed
   * env, OFF locally and in test/CI. These four cases pin both halves plus the
   * explicit overrides, because the previous env-var-only form silently never
   * turned enforcement on in ANY deployed environment (the var was set in no
   * ConfigMap, and the GitOps db-migrate Job has no `envFrom` to carry it).
   *
   * "Deployed" is `!isCI() && NODE_ENV !== 'test' && no env file loaded`, so it
   * is simulated by stubbing NODE_ENV/CI and mocking the env module's
   * `loadDatabaseEnv` to report that no file was found.
   */
  async function loadWithEnvPosture(opts: { nodeEnv: string; ci: string; envFileLoaded: boolean }) {
    vi.stubEnv('NODE_ENV', opts.nodeEnv);
    vi.stubEnv('CI', opts.ci);
    vi.doMock('../../../../env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../env')>();
      return { ...actual, loadDatabaseEnv: () => ({ loaded: opts.envFileLoaded }) };
    });
    return (await import('../15-entitlements')).seedEntitlements;
  }

  it('defaults BOTH switches ON when unset in a DEPLOYED env (host-env-only: not CI, not test, no env file)', async () => {
    const seedEntitlements = await loadWithEnvPosture({ nodeEnv: 'development', ci: '', envFileLoaded: false });
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    expect(upserts.find((u) => (u.create as { key?: string }).key === 'entitlements.enabled')!.create.value).toBe('true');
    expect(upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!.create.value).toBe('true');
  });

  it('defaults enforcement ON but metering reconcile OFF on a developer laptop (TASK-785 OD-6)', async () => {
    // The two switches diverge here, and only here. Enforcement is a product
    // behaviour a developer should meet locally; the reconcile sweep is a
    // background snapshot job that enforcement does not depend on, so it keeps
    // its deployed-only posture.
    const seedEntitlements = await loadWithEnvPosture({ nodeEnv: 'development', ci: '', envFileLoaded: true });
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    expect(upserts.find((u) => (u.create as { key?: string }).key === 'entitlements.enabled')!.create.value).toBe('true');
    expect(upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!.create.value).toBe('false');
  });

  it('defaults BOTH switches OFF in CI even with no env file (the E2E baseline must not flip)', async () => {
    const seedEntitlements = await loadWithEnvPosture({ nodeEnv: 'development', ci: 'true', envFileLoaded: false });
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    expect(upserts.find((u) => (u.create as { key?: string }).key === 'entitlements.enabled')!.create.value).toBe('false');
    expect(upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!.create.value).toBe('false');
  });

  it('an EXPLICIT falsy env var still forces OFF in a deployed env (operator override survives the inverted default)', async () => {
    vi.stubEnv('ENTITLEMENTS_ENABLED_DEFAULT', 'false');
    const seedEntitlements = await loadWithEnvPosture({ nodeEnv: 'development', ci: '', envFileLoaded: false });
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    expect(upserts.find((u) => (u.create as { key?: string }).key === 'entitlements.enabled')!.create.value).toBe('false');
    // …while the independent metering switch still takes the deployed default.
    expect(upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!.create.value).toBe('true');
  });

  it('the metering switch is independently env-driven from the entitlements switch', async () => {
    vi.stubEnv('ENTITLEMENTS_ENABLED_DEFAULT', 'true');
    vi.stubEnv('METERING_RECONCILE_ENABLED_DEFAULT', ''); // stays unset
    const seedEntitlements = await loadSeedEntitlements();
    const { client, upserts } = makeMockClient();

    await seedEntitlements(client as never);

    const entitlementsUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'entitlements.enabled')!;
    const meteringUpsert = upserts.find((u) => (u.create as { key?: string }).key === 'metering.reconcile.enabled')!;
    expect(entitlementsUpsert.create.value).toBe('true');
    expect(meteringUpsert.create.value).toBe('false');
  });
});

/*
 * Test 40 — OD-7, seed side.
 *
 * `featurePlatformDefaultCredential` grants a tenant's provider-credential
 * cascade access to the SYSTEM (platform-funded) tier. NO plan tier carries it:
 * a plan-level `true` on PRO or ENTERPRISE would hand every tenant on that plan
 * a platform-funded cloud path, reopening exactly the margin hole
 * closed when it ratified "SYSTEM default stays self-hosted, managed cloud is a
 * paid add-on" (see `managed-asr-addon-posture.test.ts`, whose posture this
 * upholds). Grants are per tenant, via `TenantEntitlement`.
 *
 * Seed-side counterpart of the resolver-side test in
 * `packages/applications/src/services/entitlements/__tests__/resolve-entitlements.test.ts`.
 */
describe('seedEntitlements — featurePlatformDefaultCredential', () => {
  it('seeds all four plan rows with the grant OFF', () => {
    expect(PLAN_ENTITLEMENTS).toHaveLength(4);
    PLAN_ENTITLEMENTS.forEach((row) => {
      expect(row.featurePlatformDefaultCredential, `plan ${row.plan} must not carry the platform-default grant`).toBe(false);
    });
  });

  it('covers every plan exactly once (a missing plan would inherit the column default silently)', () => {
    const plans = PLAN_ENTITLEMENTS.map((row) => row.plan).sort();
    expect(plans).toEqual(['ENTERPRISE', 'PRO', 'STARTER', 'TRIAL']);
  });

  it('writes the grant into the create branch, and never into the update branch (re-seed must not clobber a granted tenant plan row)', async () => {
    const seedEntitlements = (await import('../15-entitlements')).seedEntitlements;
    const planUpserts: Array<{ update: Record<string, unknown>; create: Record<string, unknown> }> = [];
    const client = {
      planEntitlement: {
        upsert: vi.fn(async (args: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
          planUpserts.push(args);
          return {};
        }),
      },
      globalSetting: { upsert: vi.fn(async () => ({})) },
    };

    await seedEntitlements(client as never);

    expect(planUpserts).toHaveLength(4);
    planUpserts.forEach((upsert) => {
      expect(upsert.create).toHaveProperty('featurePlatformDefaultCredential', false);
      expect(upsert.update).toEqual({});
    });
  });
});
