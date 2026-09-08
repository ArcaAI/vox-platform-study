/**
 * TASK-932 R-8 / D-3 / D-4 — the `Feature Availability` category is the ONE
 * surface a platform admin uses to decide which features exist, per tenant.
 *
 * These tests pin the three things a future change is most likely to get wrong,
 * in the order they would hurt:
 *
 *  1. The old "Feature Flags" bucket is GONE. It named three unrelated things at
 *     once (un-writable env gates, consultation kill-switches, a legacy
 *     `GlobalSetting` namespace of advisory rows), which is why nobody could say
 *     what a "feature flag" was in this codebase. If a new descriptor
 *     reintroduces the string, the ambiguity comes back with it.
 *  2. Every row on the matrix is `global-kv` + boolean + `globalOnly`. A key
 *     that is not writable without a redeploy cannot be a matrix cell, and a key
 *     a tenant could set for itself is not being gated by the platform.
 *  3. The migrated keys kept their KEY and their DEFAULT. A migration that
 *     changes the default silently flips a live gate on the next deploy.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_FEATURE_KEYS,
  FEATURE_AVAILABILITY_CATEGORY,
  FEATURE_AVAILABILITY_KEYS,
  LIVE_DOC_GROUNDEDNESS_ENABLED_KEY,
  REGISTRATION_SELF_SIGNUP_ENABLED_KEY,
  WORKFLOW_EXPOSURE_ENABLED_KEY,
} from '../descriptors/feature-availability.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const featureRows = () => HOPE_SETTINGS_REGISTRY.list().filter((d) => d.category === FEATURE_AVAILABILITY_CATEGORY);

describe('Feature Availability category', () => {
  it('no descriptor anywhere still claims the dissolved "Feature Flags" category', () => {
    expect(HOPE_SETTINGS_REGISTRY.list().filter((d) => d.category === 'Feature Flags')).toEqual([]);
  });

  it('carries the four console gates plus the three migrated keys and the realtime graph executor', () => {
    const keys = featureRows().map((d) => d.key).sort();
    expect(keys).toEqual(
      [
        CONSOLE_FEATURE_KEYS.agenticPolicy,
        CONSOLE_FEATURE_KEYS.mlflow,
        CONSOLE_FEATURE_KEYS.toolsMcp,
        CONSOLE_FEATURE_KEYS.workflowHarness,
        'consultation.realtime.graphExecutor.enabled',
        LIVE_DOC_GROUNDEDNESS_ENABLED_KEY,
        REGISTRATION_SELF_SIGNUP_ENABLED_KEY,
        WORKFLOW_EXPOSURE_ENABLED_KEY,
      ].sort(),
    );
  });

  it('every row is a boolean on the global-kv tier — a redeploy-only gate cannot be a matrix cell', () => {
    for (const d of featureRows()) {
      expect(d.tier, d.key).toBe('global-kv');
      expect(d.dataType, d.key).toBe('boolean');
      // A gate whose read raises would take a console screen (or the public
      // workflow plane) down with the control plane.
      expect(d.failMode, d.key).toBe('open-to-default');
    }
  });

  it('every row is globalOnly — a tenant that can grant itself a feature is not being gated', () => {
    for (const d of featureRows()) expect(d.globalOnly, d.key).toBe(true);
  });

  it('a per-tenant row is offered only where the consumer HAS a tenant to resolve against', () => {
    // `registration.selfSignupEnabled` is the exception, and it is the exception
    // for a reason that is checkable: `RegisterController`'s routes are
    // `@Public()`, so there is no tenant a cascade could honour. Declaring
    // `maxScope: 'tenant'` would advertise a per-tenant control that does
    // nothing — the failure mode this assertion exists to prevent.
    const byKey = Object.fromEntries(featureRows().map((d) => [d.key, d]));
    expect(byKey[REGISTRATION_SELF_SIGNUP_ENABLED_KEY]!.maxScope).toBe('system');
    for (const key of FEATURE_AVAILABILITY_KEYS.filter((k) => k !== REGISTRATION_SELF_SIGNUP_ENABLED_KEY)) {
      expect(byKey[key]!.maxScope, key).toBe('tenant');
    }
  });

  it('keeps the migrated keys and their defaults byte for byte', () => {
    const byKey = Object.fromEntries(featureRows().map((d) => [d.key, d]));
    expect(byKey[REGISTRATION_SELF_SIGNUP_ENABLED_KEY]!.default).toBe(false);
    // Ships ON (TASK-890 J7-5). A migration that flipped this would 404 the
    // whole public workflow plane on the next deploy.
    expect(byKey[WORKFLOW_EXPOSURE_ENABLED_KEY]!.default).toBe(true);
    expect(byKey[LIVE_DOC_GROUNDEDNESS_ENABLED_KEY]!.default).toBe(false);
  });

  it('the four console gates default OFF and are marked kill-switches, per D-1', () => {
    const byKey = Object.fromEntries(featureRows().map((d) => [d.key, d]));
    for (const key of Object.values(CONSOLE_FEATURE_KEYS)) {
      expect(byKey[key], key).toBeDefined();
      expect(byKey[key]!.default, key).toBe(false);
      expect(byKey[key]!.killSwitch, key).toBe(true);
    }
    // A default-ON descriptor may NOT carry the marker: `killSwitches()` throws
    // on a truthy default, so the polarity rule and registry assembly are the
    // same statement.
    expect(byKey[WORKFLOW_EXPOSURE_ENABLED_KEY]!.killSwitch).toBeUndefined();
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('says in plain words that a console gate is visibility and not authorisation (D-2)', () => {
    // The one sentence that stops a reader mistaking a nav toggle for a
    // permission — and stops the next author "hardening" it into one.
    for (const key of Object.values(CONSOLE_FEATURE_KEYS)) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)!.description).toMatch(/VISIBILITY ONLY/);
    }
  });
});

describe('the keys that left the dissolved category', () => {
  it('harness.claimCheck.enabled is service runtime, still env, and still default ON', () => {
    const d = HOPE_SETTINGS_REGISTRY.get('harness.claimCheck.enabled')!;
    expect(d.category).toBe('Service Runtime');
    // Its reader is pydantic-settings inside the Python harness worker; moving
    // it needs the effective-config pull route, which D-4 keeps out of scope.
    expect(d.tier).toBe('env');
    expect(d.targetTier).toBe('global-kv');
    expect(d.default).toBe(true);
    expect(d.killSwitch).toBeUndefined();
  });

  it('the consultation gates that are not feature availability keep their own category', () => {
    for (const key of [
      'consultation.ocr.enabled',
      'consultation.state.requirePrimedBeforeRecording',
      'consultation.state.sessionTimeoutMinutes',
      'consultation.state.sessionTimeoutSweep.cron',
    ]) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)!.category, key).toBe('Consultation Pipeline');
    }
  });

  it('the loop emergency stop is platform operations — its polarity is inverted', () => {
    // `true` means STOP. A column headed "available" would read backwards for
    // it, which is why it is not a matrix row however boolean it looks.
    expect(HOPE_SETTINGS_REGISTRY.get('harness.loop.emergencyStop')!.category).toBe('Platform Operations');
  });
});
