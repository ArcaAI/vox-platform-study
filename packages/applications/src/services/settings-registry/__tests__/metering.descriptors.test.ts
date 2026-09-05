// Metering descriptor contract tests.
//
// Handoff: the outbox-drainer schedule
// (`metering.outbox.drain.enabled` / `.intervalSeconds`) was live and
// consumed (`usage-outbox.processor.ts#UsageOutboxScheduler.getConfig`)
// but never cataloged. `metering.reconcile.enabled` mirrors
// `entitlements.enabled`'s env-driven fresh-DB seed pattern (policy:
// ON in every DEPLOYED env — hope-v2-dev/staging/production — OFF in local dev
// and test/CI) via a companion `.enabledDefault` SEED-TIME-ONLY key, exactly
// like `entitlements.enabledDefault` (feature-flags.descriptors.ts) already does.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
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

  // Was: "registers metering.reconcile.enabledDefault as the seed-time-only
  // companion". TASK-872 deleted that descriptor and its
  // `entitlements.enabledDefault` twin, so the assertion flips to the absence.
  // The SEED is unaffected and keeps its `process.env` override — what must not
  // come back is a settings-registry descriptor for a variable no running
  // process reads, because its only effect was to emit a stanza into the
  // generated `.env.sample` that `pnpm setup:dev` then copies into `.env.dev`.
  it('registers NO seed-time-only companion key — seeding reads host env, not this registry', () => {
    expect(registryByKey.has('metering.reconcile.enabledDefault')).toBe(false);
    expect(registryByKey.has('entitlements.enabledDefault')).toBe(false);
  });

  it('the registry assembles without throwing (killSwitches() re-validates default-OFF)', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('keeps every registry key unique (no duplicate registration)', () => {
    const keys = DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
