import { describe, expect, it } from 'vitest';
import { PLATFORM_TTS_LIMITS, resolveEffectiveTtsConfig } from '../platform-limits';

const D = PLATFORM_TTS_LIMITS.codeDefaults;

describe('resolveEffectiveTtsConfig (TASK-496)', () => {
  it('falls back to code defaults when neither system nor tenant is set', () => {
    const eff = resolveEffectiveTtsConfig(null, null);
    expect(eff.routingEn).toEqual(D.routingEn);
    // sarvamPublicApiAllowed defaults false → sarvam stripped from the default ml
    // chain (safe PHI posture); azure/indic_parler remain.
    expect(eff.routingMl).toEqual(['azure', 'indic_parler']);
    expect(eff.defaultVoiceEn).toBe(D.defaultVoiceEn);
    expect(eff.defaultFormat).toBe('pcm');
    expect(eff.defaultSpeed).toBe(1.0);
    expect(eff.sampleRate).toBe(24000);
    expect(eff.maxInputChars).toBe(4096);
    expect(eff.sarvamPublicApiAllowed).toBe(false);
  });

  it('tenant row overrides the SYSTEM default; SYSTEM overrides code default', () => {
    const eff = resolveEffectiveTtsConfig(
      { defaultVoiceEn: 'en-male-1', defaultSpeed: 1.5 },
      { defaultSpeed: 2.0 },
    );
    expect(eff.defaultVoiceEn).toBe('en-male-1'); // inherited from SYSTEM (tenant unset)
    expect(eff.defaultSpeed).toBe(2.0); // tenant wins
  });

  it('clamps speed, sample rate, format, and max input chars to platform limits', () => {
    const eff = resolveEffectiveTtsConfig(null, {
      defaultSpeed: 99,
      sampleRate: 12345,
      defaultFormat: 'ogg',
      maxInputChars: 999999,
    });
    expect(eff.defaultSpeed).toBe(PLATFORM_TTS_LIMITS.speedMax);
    expect(eff.sampleRate).toBe(D.sampleRate); // invalid → code default
    expect(eff.defaultFormat).toBe(D.defaultFormat); // invalid → code default
    expect(eff.maxInputChars).toBe(PLATFORM_TTS_LIMITS.maxInputCharsCeiling);
  });

  it('drops unknown providers and bounds routing to the allowed-provider whitelist', () => {
    const eff = resolveEffectiveTtsConfig(null, {
      allowedProviders: ['azure'],
      routingMl: ['azure', 'sarvam', 'bogus'],
      sarvamPublicApiAllowed: true,
    });
    expect(eff.allowedProviders).toEqual(['azure']);
    expect(eff.routingMl).toEqual(['azure']); // sarvam not whitelisted, bogus unknown
  });

  it('strips sarvam from routing + whitelist when the PHI toggle is off', () => {
    const eff = resolveEffectiveTtsConfig(null, {
      routingMl: ['sarvam', 'azure', 'indic_parler'],
      sarvamPublicApiAllowed: false,
    });
    expect(eff.routingMl).toEqual(['azure', 'indic_parler']);
    expect(eff.allowedProviders).not.toContain('sarvam');
  });

  it('keeps sarvam when the PHI toggle is on', () => {
    const eff = resolveEffectiveTtsConfig(null, {
      routingMl: ['sarvam', 'azure'],
      sarvamPublicApiAllowed: true,
    });
    expect(eff.routingMl).toEqual(['sarvam', 'azure']);
  });

  it('empty routing falls back to the (whitelist-clamped) code default', () => {
    const eff = resolveEffectiveTtsConfig(null, { allowedProviders: ['azure', 'kokoro'], routingEn: [] });
    expect(eff.routingEn).toEqual(['azure', 'kokoro']);
  });
});

/**
 * Registry-driven provider universe. `resolveEffectiveTtsConfig`
 * takes an optional `universe` (the ENABLED SYSTEM TTS registry providers) that
 * replaces the code-constant universe in the allowedProviders clamp, the
 * routing-chain clamps AND the code-default fallback chains, so DISABLING a
 * registry row disables the provider platform-wide. Omitted universe = the code
 * constant = today's behaviour byte-for-byte.
 */
describe('resolveEffectiveTtsConfig — registry universe (r2605 Finding F)', () => {
  it('omitted universe is byte-for-byte identical to the code-constant behaviour', () => {
    const system = { routingEn: ['azure', 'kokoro'], allowedProviders: ['azure', 'kokoro', 'sarvam'] };
    const tenant = { defaultSpeed: 1.5, sarvamPublicApiAllowed: true };
    expect(resolveEffectiveTtsConfig(system, tenant, undefined)).toEqual(resolveEffectiveTtsConfig(system, tenant));
  });

  it('a provider absent from the registry universe is stripped from allowedProviders AND the routing chains', () => {
    // azure's registry row is disabled/absent → universe has no azure.
    const universe = new Set(['kokoro', 'indic_parler', 'sarvam']);
    const eff = resolveEffectiveTtsConfig(null, null, universe);
    // Code default routingEn ['azure','kokoro'] → azure stripped.
    expect(eff.routingEn).toEqual(['kokoro']);
    // Code default routingMl ['azure','sarvam','indic_parler'] → azure stripped,
    // sarvam stripped by the PHI toggle default.
    expect(eff.routingMl).toEqual(['indic_parler']);
    expect(eff.allowedProviders).not.toContain('azure');
  });

  it('the code-default FALLBACK chain is also clamped to the universe when a tenant chain empties', () => {
    // Tenant routes only via azure, but azure is platform-disabled → the chain
    // empties and the code-default fallback must come back universe-clamped.
    const universe = new Set(['kokoro', 'indic_parler']);
    const eff = resolveEffectiveTtsConfig(null, { routingEn: ['azure'] }, universe);
    expect(eff.routingEn).toEqual(['kokoro']); // code default ['azure','kokoro'] clamped
  });

  it('a REGISTRY-ONLY provider (not in the code constant) survives the clamps', () => {
    const universe = new Set(['kokoro', 'elevenlabs']);
    const eff = resolveEffectiveTtsConfig(null, { routingEn: ['elevenlabs', 'kokoro'], allowedProviders: ['elevenlabs', 'kokoro'] }, universe);
    expect(eff.routingEn).toEqual(['elevenlabs', 'kokoro']);
    expect(eff.allowedProviders).toEqual(['elevenlabs', 'kokoro']);
  });

  it('an empty whitelist under a registry universe resets to THAT universe (minus sarvam by default)', () => {
    const universe = new Set(['kokoro', 'sarvam']);
    const eff = resolveEffectiveTtsConfig(null, null, universe);
    expect(eff.allowedProviders).toEqual(['kokoro']); // universe reset, sarvam PHI-stripped
  });
});
