// Metering descriptor contract tests (TASK-615 WS-H).
//
// WS-B's handoff (ws-b-contract.md §11): the outbox-drainer schedule
// (`metering.outbox.drain.enabled` / `.intervalSeconds`) was live and
// consumed (`usage-outbox.processor.ts#UsageOutboxScheduler.getConfig`)
// but never cataloged. `metering.reconcile.enabled` mirrors
// `entitlements.enabled`'s env-driven fresh-DB seed pattern (OQ3: ON in
// dev/staging, OFF in test/CI/prod) via a companion `.enabledDefault`
// SEED-TIME-ONLY key, exactly like `entitlements.enabledDefault`
// (feature-flags.descriptors.ts) already does.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { toEnvVarName } from '../registry.types';
import { DRAIN_DEFAULTS, DRAIN_ENABLED_KEY, DRAIN_INTERVAL_SECONDS_KEY } from '../../usageLedger/usage-ledger.constants';
import { METERING_DEFAULTS, METERING_ENABLED_KEY } from '../../metering/metering.constants';

const DESCRIPTORS = HOPE_SETTINGS_REGISTRY.list();
const registryByKey = new Map(DESCRIPTORS.map((d) => [d.key, d]));

describe('metering descriptors', () => {
  it('registers the outbox-drain schedule at its CURRENT runtime defaults (registering changes zero behaviour)', () => {
    const enabled = registryByKey.get(DRAIN_ENABLED_KEY);
    expect(enabled).toBeDefined();
    expect(enabled!.tier).toBe('global-kv');
    expect(enabled!.dataType).toBe('boolean');
    expect(enabled!.failMode).toBe('open-to-default');
    expect(enabled!.default).toBe(DRAIN_DEFAULTS.enabled);
    // DRAIN_DEFAULTS.enabled is `true` — a PROTECTION-enable flag (a ledger
    // nobody drains is worse than no ledger), same polarity as
    // `rate-limit.enabled`. Marking it `killSwitch: true` would fail registry
    // assembly (kill-switches must default OFF) AND mislabel the polarity.
    expect(enabled!.killSwitch).toBeFalsy();

    const interval = registryByKey.get(DRAIN_INTERVAL_SECONDS_KEY);
    expect(interval).toBeDefined();
    expect(interval!.tier).toBe('global-kv');
    expect(interval!.dataType).toBe('number');
    expect(interval!.failMode).toBe('open-to-default');
    expect(interval!.default).toBe(DRAIN_DEFAULTS.intervalSeconds);
  });

  it('registers metering.reconcile.enabled as a fail-safe kill-switch (defaults OFF)', () => {
    const descriptor = registryByKey.get(METERING_ENABLED_KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.dataType).toBe('boolean');
    expect(descriptor!.failMode).toBe('open-to-default');
    expect(descriptor!.killSwitch).toBe(true);
    expect(descriptor!.default).toBe(METERING_DEFAULTS.enabled);
    expect(descriptor!.default).toBe(false);
  });

  it('registers metering.reconcile.enabledDefault as the seed-time-only companion (env tier, mirrors entitlements.enabledDefault)', () => {
    const descriptor = registryByKey.get('metering.reconcile.enabledDefault');
    expect(descriptor).toBeDefined();
    expect(descriptor!.tier).toBe('env');
    expect(descriptor!.targetTier).toBe('global-kv');
    expect(descriptor!.dataType).toBe('boolean');
    expect(descriptor!.failMode).toBe('open-to-default');
    expect(descriptor!.default).toBe(false);
    // Not a runtime gate — no admin write surface (mirrors entitlements.enabledDefault).
    expect(descriptor!.editableBy).toBe('none');
    expect(toEnvVarName(descriptor!.key)).toBe('METERING_RECONCILE_ENABLED_DEFAULT');
  });

  it('the registry assembles without throwing (killSwitches() re-validates default-OFF)', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('keeps every registry key unique (no duplicate registration)', () => {
    const keys = DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
