/**
 * TASK-959 W0 — `metering.compute.deviceByProvider`.
 *
 * ============================================================================
 * WHAT THIS KEY DECIDES, AND WHY THAT MAKES IT UNUSUAL
 * ============================================================================
 * Every other metering knob schedules a job. This one picks a UNIT: the
 * emitters record a self-hosted LLM call's occupancy seconds as `GPU_SECOND`
 * when the serving provider's device is `cuda`/`mps` and `CPU_SECOND` when it
 * is `cpu`, and the two are priced an order of magnitude apart. The text
 * service cannot report a device — there is no `device` field on
 * `ProviderOverride`, `GenerateRequest` or `AiModel`, and `computeType` is a
 * precision, not a device (§3.1) — so for the LLM engines the device is
 * SUPPLIED by configuration rather than observed.
 *
 * Which is why the posture is `open-to-default` and the default resolves to
 * `cpu`: an unlisted provider must record the CHEAPER unit, never nothing. A
 * mis-set entry records the wrong unit until corrected — visible on the
 * consumption screen and correctable by a compensating event — and that is a
 * stated R1 blind spot (§3.5), not a hidden one.
 *
 * ============================================================================
 * THE TIER IS `global-kv`, NOT `db-config` (a deviation, deliberately)
 * ============================================================================
 * The ticket's §3.1 names `db-config`. That tier cannot deliver what the same
 * sentence asks for (a SYSTEM default with a tenant override), and both halves
 * were verified against the code on this branch:
 *
 *   READ  — `EffectiveSettingsService.resolveEffective` dispatches `db-config`
 *           per key FAMILY, and the only family with a lane is platform storage
 *           (`PLATFORM_STORAGE_KEYS`). Any other `db-config` key falls through
 *           to `throw new ArgumentInvalidException("No effective resolver is
 *           registered for setting …")`.
 *   WRITE — `SettingsRegistryWriteService` refuses every tier but `global-kv`
 *           ("Tier 'db-config' is not writable through the registry lane"), so
 *           no tenant admin could set the override the key exists to provide.
 *
 * `global-kv` gives exactly the declared semantics: `TenantSettingsService
 * .resolve` walks tenant override → SYSTEM row → descriptor default and reports
 * which tier answered. This is the same deviation `user-identity.descriptors.ts`
 * took for TASK-950 D-9, for the same two reasons, and it is recorded there too.
 */

import { describe, expect, it } from 'vitest';

import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { COMPUTE_DEVICE_BY_PROVIDER_DEFAULT, COMPUTE_DEVICE_BY_PROVIDER_KEY, METERING_COMPUTE_SETTINGS } from '../descriptors/metering-compute.descriptors';
import { COMPUTE_DEVICES } from '../../usageLedger/usage-attributes';

const descriptor = HOPE_SETTINGS_REGISTRY.get(COMPUTE_DEVICE_BY_PROVIDER_KEY);

describe('metering.compute.deviceByProvider — registration', () => {
  it('is registered in the assembled catalog (registering is the ONLY step that makes a key governed)', () => {
    expect(descriptor).toBeDefined();
  });

  it('exports exactly one descriptor from its own file', () => {
    expect(METERING_COMPUTE_SETTINGS.map((d) => d.key)).toEqual([COMPUTE_DEVICE_BY_PROVIDER_KEY]);
  });

  it('is a tenant-overridable JSON map that falls back to its default', () => {
    expect(descriptor!.dataType).toBe('json');
    // See the header: `db-config` would be unreadable AND unwritable.
    expect(descriptor!.tier).toBe('global-kv');
    // A tenant that brings its OWN self-hosted server decides that server's
    // device; the SYSTEM row is the platform's answer for everyone else.
    expect(descriptor!.maxScope).toBe('tenant');
    expect(descriptor!.globalOnly).toBeFalsy();
    expect(descriptor!.editableBy).toBe('GlobalSetting');
    expect(descriptor!.sensitivity).toBe('internal');
  });

  it('is `open-to-default`, never fail-closed — an unresolved device must record the CHEAPER unit', () => {
    // Fail-closed here would make a missing provider entry raise on the
    // EMITTING path, i.e. lose the whole usage batch (tokens included) to
    // protect a device label. The rule is: no entry ⇒ `cpu`.
    expect(descriptor!.failMode).toBe('open-to-default');
    expect(descriptor!.description).toMatch(/cpu/);
  });

  it('is NOT a kill-switch and declares no `consumedBy`', () => {
    expect(descriptor!.killSwitch).toBeFalsy();
    // Cardinality decides the channel (D-1): the pull route is PLATFORM-scope,
    // one cached snapshot per process. A tenant-scoped key on it would become
    // one cached entry per tenant. It is read by the gateway's own emitters.
    expect(descriptor!.consumedBy).toBeUndefined();
  });
});

describe('the SYSTEM default', () => {
  it('names the four self-hosted LLM servers, GPU-hosted except llama.cpp', () => {
    expect(COMPUTE_DEVICE_BY_PROVIDER_DEFAULT).toEqual({
      'lm-studio': 'cuda',
      vllm: 'cuda',
      ollama: 'cuda',
      'llama-cpp': 'cpu',
    });
    expect(descriptor!.default).toEqual(COMPUTE_DEVICE_BY_PROVIDER_DEFAULT);
  });

  it('uses only devices the ledger attribute vocabulary accepts', () => {
    // One vocabulary, two consumers. A device spelled here but not there would
    // be rejected by `validateUsageAttributes` at emit time — after the
    // descriptor had already chosen the unit.
    for (const device of Object.values(COMPUTE_DEVICE_BY_PROVIDER_DEFAULT)) {
      expect(COMPUTE_DEVICES).toContain(device);
    }
  });

  it('uses provider ids spelled exactly as the ledger vocabulary spells them', () => {
    // `lmstudio` / `llamacpp` would silently never match, so every such call
    // would resolve to the `cpu` fallback and be metered as the cheap unit.
    expect(Object.keys(COMPUTE_DEVICE_BY_PROVIDER_DEFAULT).sort()).toEqual(['llama-cpp', 'lm-studio', 'ollama', 'vllm']);
  });

  it('passes its own validator (a default that could not be written is a trap)', () => {
    expect(descriptor!.validate?.(COMPUTE_DEVICE_BY_PROVIDER_DEFAULT)).toBeUndefined();
  });
});

describe('the validator', () => {
  const validate = (value: unknown) => descriptor!.validate?.(value);

  it('accepts an empty map — "no provider has an opinion" is a legal state', () => {
    expect(validate({})).toBeUndefined();
  });

  it('accepts a tenant adding its own self-hosted server', () => {
    expect(validate({ 'my-vllm-box': 'cuda' })).toBeUndefined();
  });

  it('REJECTS a device outside the closed vocabulary, and names the permitted values', () => {
    const message = validate({ 'lm-studio': 'gpu' });
    expect(message).toBeTypeOf('string');
    expect(message).toMatch(/lm-studio/);
    expect(message).toMatch(/cuda/);
  });

  it('REJECTS a mis-shaped provider id — it would never match, so it would silently fall back', () => {
    // An entry that cannot match is worse than no entry: the admin believes the
    // device is set and every call is metered as CPU_SECOND.
    expect(validate({ 'LM-Studio': 'cuda' })).toBeTypeOf('string');
    expect(validate({ 'lm studio': 'cuda' })).toBeTypeOf('string');
    expect(validate({ '': 'cuda' })).toBeTypeOf('string');
  });

  it('REJECTS a non-object, an array and a nested value', () => {
    expect(validate('lm-studio=cuda')).toBeTypeOf('string');
    expect(validate([['lm-studio', 'cuda']])).toBeTypeOf('string');
    expect(validate(null)).toBeTypeOf('string');
    expect(validate({ 'lm-studio': { device: 'cuda' } })).toBeTypeOf('string');
  });

  it('reports EVERY bad entry, not just the first', () => {
    const message = validate({ 'lm-studio': 'gpu', vllm: 'tpu' }) as string;
    expect(message).toMatch(/lm-studio/);
    expect(message).toMatch(/vllm/);
  });
});

describe('registry-wide invariants still hold with the key registered', () => {
  it('assembles without throwing (duplicate keys, kill-switch polarity)', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
    const keys = HOPE_SETTINGS_REGISTRY.list().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
