/**
 * TASK-1001 (owner decision 2026-09-23) — `consultation.summary.outputLanguage`, the PLATFORM
 * DEFAULT for the language a consultation note is written in when the tenant's output-language
 * policy fragment is not selected.
 *
 * What is pinned, because each one fails SILENTLY when it drifts:
 *  1. The exact key. Three runtimes read it by name (the live lane, the durable handoff and the
 *     summary service); a renamed key is a default nobody can ever change.
 *  2. The channel: `global-kv`, SYSTEM-only. The tenant's lever is its policy fragment; a tenant
 *     row here would be a second, unconditional place to say the same thing.
 *  3. `open-to-default` with default `en`: absent must mean English, never "no instruction" — the
 *     posture that let the corpus's "write in the conversation language" clause produce a
 *     code-switched note.
 *  4. The value grammar: ONE language. A code-switch mode (`ml-en`) describes what is spoken and is
 *     refused as a value, rather than accepted and later read as "Malayalam".
 *  5. Registering the descriptor is the ONLY step needed to govern the key: the read facade answers
 *     it with no further wiring.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { EffectiveSettingsService } from '../effective-settings.service';
import {
  CONSULTATION_OUTPUT_LANGUAGE_DEFAULT,
  CONSULTATION_OUTPUT_LANGUAGE_KEY,
  CONSULTATION_OUTPUT_LANGUAGE_SETTINGS,
} from '../descriptors/consultation-output-language.descriptors';

const KEY = 'consultation.summary.outputLanguage';

describe('TASK-1001 — consultation.summary.outputLanguage descriptor', () => {
  it('registers exactly this key, once', () => {
    expect(CONSULTATION_OUTPUT_LANGUAGE_KEY).toBe(KEY);
    expect(CONSULTATION_OUTPUT_LANGUAGE_SETTINGS.map((d) => d.key)).toEqual([KEY]);
    expect(HOPE_SETTINGS_REGISTRY.has(KEY)).toBe(true);
  });

  it('is a PLATFORM-scope global-kv string, editable by a platform admin only', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY);
    expect(d.tier).toBe('global-kv');
    expect(d.dataType).toBe('string');
    expect(d.maxScope).toBe('system');
    expect(d.globalOnly).toBe(true);
    expect(d.editableBy).toBe('GlobalSetting');
    expect(d.sensitivity).toBe('internal');
    expect(d.label).toBeTruthy();
    expect(d.description).toBeTruthy();
  });

  it('defaults OPEN to English — absent never means "no language stated"', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY);
    expect(d.failMode).toBe('open-to-default');
    expect(d.default).toBe('en');
    expect(CONSULTATION_OUTPUT_LANGUAGE_DEFAULT).toBe('en');
  });

  it('is not served on the Python pull route — the gateway is its only reader', () => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).consumedBy).toBeUndefined();
  });

  it('accepts ONE language tag', () => {
    const validate = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).validate!;
    expect(validate).toBeTypeOf('function');
    for (const ok of ['en', 'ml', 'en-IN', 'hi']) expect(validate(ok), ok).toBeFalsy();
  });

  it('REFUSES a code-switch mode as a value — an output language cannot be "mixed"', () => {
    const validate = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).validate!;
    for (const mixed of ['ml-en', 'en-ml']) expect(validate(mixed), mixed).toMatch(/code-switch/);
  });

  it('refuses a display name, blank, padding and non-strings', () => {
    const validate = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).validate!;
    for (const bad of ['English', '', ' en', 'en ', 42, null, undefined, true]) expect(validate(bad), String(bad)).toBeTruthy();
  });

  it('is governed by registration alone: the read facade answers it, falling to English when nothing is stored', async () => {
    // No tenant-settings backend wired ⇒ the declared failMode applies, exactly as for every sibling.
    const resolved = await new EffectiveSettingsService().resolveEffective(KEY, { tenantId: '50000000-0000-0000-0000-000000000001' });
    expect(resolved).toMatchObject({ key: KEY, tier: 'global-kv', value: 'en', sourceScope: 'code-default' });
  });
});
