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
