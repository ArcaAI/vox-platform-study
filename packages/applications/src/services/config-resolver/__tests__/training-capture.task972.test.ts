/**
 * TASK-972 Lane 2 — the training-capture opt-out.
 *
 * Routing the clinician's submit into HOPE turns `GateEditExemplar` from a pipeline with no
 * live writer into a high-volume one, and mining runs UNCONDITIONALLY today — there is no
 * consent check anywhere in it (§2.4). OD-4 wires a doctor/tenant opt-out now, mirroring DNA,
 * with the full `ConsentGrant` binding filed as FU-4.
 *
 * Two gates, `effective = tenantEnabled && (doctorToggle ?? true)`:
 *
 *  - the TENANT gate is a settings-registry descriptor on the tenant → SYSTEM cascade, default
 *    ENABLED, because mining runs today and a default of OFF would silently disable a shipped
 *    feature;
 *  - the DOCTOR toggle is a three-state `UserSettings` row: `true` opt-in, `false` opt-out, no
 *    row = no opinion, read as an implicit opt-in.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigResolver } from '../config-resolver.service';
import { TRAINING_CAPTURE_PREFERENCE, parseTrainingCapturePreference } from '../training-capture-preference';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { TRAINING_CAPTURE_ENABLED_KEY } from '../../settings-registry/descriptors/training-capture.descriptors';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';

/** Positional construction, exactly as the production graph and every sibling fixture does it. */
const build = (opts: { settingValue?: unknown; settingThrows?: boolean; preference?: unknown; preferenceThrows?: boolean; noSettings?: boolean } = {}) => {
  const userSettingsRepository = {
    findByUserKeyNamespace: vi.fn(async () => {
      if (opts.preferenceThrows) throw new Error('db down');
      return opts.preference === undefined ? null : { value: opts.preference, version: 4 };
    }),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async () => {
      if (opts.settingThrows) throw new Error('settings backend down');
      return { key: TRAINING_CAPTURE_ENABLED_KEY, tier: 'global-kv', value: opts.settingValue, sourceScope: 'tenant' };
    }),
  };
  const resolver = new ConfigResolver(
    undefined as never,
    undefined as never,
    undefined as never,
    userSettingsRepository as never,
    opts.noSettings ? (undefined as never) : (effectiveSettings as never),
  );
  return { resolver, userSettingsRepository, effectiveSettings };
};

describe('parseTrainingCapturePreference — three states, never two', () => {
  it('reads an explicit opt-in', () => {
    expect(parseTrainingCapturePreference(true)).toBe(true);
    expect(parseTrainingCapturePreference('true')).toBe(true);
  });
  it('reads an explicit opt-out', () => {
    expect(parseTrainingCapturePreference(false)).toBe(false);
    expect(parseTrainingCapturePreference('false')).toBe(false);
  });
  it('reads anything else as NO OPINION, never as an opt-out', () => {
    expect(parseTrainingCapturePreference(undefined)).toBeNull();
    expect(parseTrainingCapturePreference('yes')).toBeNull();
    expect(parseTrainingCapturePreference(null)).toBeNull();
  });
});

describe('ConfigResolver.resolveEffectiveTrainingCaptureEnabled', () => {
  it('is ENABLED by default — an unconfigured deployment mines exactly as it does today', async () => {
    const { resolver } = build({ settingValue: undefined });
    await expect(resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR })).resolves.toEqual({
      effective: true,
      tenantEnabled: true,
      doctorToggle: null,
    });
  });

  it('honours an explicit DOCTOR opt-out under an enabled tenant', async () => {
    const { resolver } = build({ settingValue: true, preference: false });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(resolved).toEqual({ effective: false, tenantEnabled: true, doctorToggle: false });
  });

  it('honours a TENANT opt-out even when the doctor opted in', async () => {
    const { resolver } = build({ settingValue: false, preference: true });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(resolved).toEqual({ effective: false, tenantEnabled: false, doctorToggle: true });
  });

  it('reads the tenant gate through the tenant → SYSTEM cascade, keyed by THIS tenant', async () => {
    const { resolver, effectiveSettings } = build({ settingValue: true });
    await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(effectiveSettings.resolveEffective).toHaveBeenCalledWith(TRAINING_CAPTURE_ENABLED_KEY, { tenantId: TENANT });
  });

  it('reads the doctor toggle from the `trainingCapture` UserSettings namespace', async () => {
    const { resolver, userSettingsRepository } = build({ settingValue: true });
    await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(userSettingsRepository.findByUserKeyNamespace).toHaveBeenCalledWith(DOCTOR, TRAINING_CAPTURE_PREFERENCE.key, TRAINING_CAPTURE_PREFERENCE.namespace);
  });

  it('degrades to ENABLED when the settings backend throws — the declared open-to-default posture', async () => {
    const { resolver } = build({ settingThrows: true });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(resolved.effective).toBe(true);
  });

  it('degrades to NO OPINION when the preference read throws — never to a silent opt-out', async () => {
    const { resolver } = build({ settingValue: true, preferenceThrows: true });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(resolved).toEqual({ effective: true, tenantEnabled: true, doctorToggle: null });
  });

  it('answers ENABLED when no settings service is wired at all', async () => {
    const { resolver } = build({ noSettings: true });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(resolved.effective).toBe(true);
  });

  it('needs no doctor at all — a tenant-only context resolves the tenant gate alone', async () => {
    const { resolver, userSettingsRepository } = build({ settingValue: false });
    const resolved = await resolver.resolveEffectiveTrainingCaptureEnabled({ tenantId: TENANT });
    expect(resolved).toEqual({ effective: false, tenantEnabled: false, doctorToggle: null });
    expect(userSettingsRepository.findByUserKeyNamespace).not.toHaveBeenCalled();
  });
});

describe('the tenant gate is a registered, tenant-overridable descriptor', () => {
  it('is in the assembled HOPE registry', () => {
    expect(HOPE_SETTINGS_REGISTRY.has(TRAINING_CAPTURE_ENABLED_KEY)).toBe(true);
  });

  it('cascades tenant → SYSTEM, defaults ENABLED, and degrades open', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(TRAINING_CAPTURE_ENABLED_KEY);
    expect(descriptor.tier).toBe('global-kv');
    expect(descriptor.dataType).toBe('boolean');
    expect(descriptor.maxScope).toBe('tenant');
    expect(descriptor.globalOnly).not.toBe(true);
    expect(descriptor.failMode).toBe('open-to-default');
    expect(descriptor.default).toBe(true);
  });
});
