/**
 * TASK-496 — platform limits + the pure effective-config resolver.
 *
 * A tenant's editable TTS spec is layered over the SYSTEM-tenant platform default
 * and clamped to these platform limits (mirrors the Entitlements / ConfigResolver
 * shape: code-default matrix → SYSTEM row → tenant row, `null`/`[]` = inherit).
 * The resolver is pure + side-effect-free so it is trivially unit-tested and the
 * gateway can call it on the hot path.
 */

/** Providers that accept a BYO credential (D1). Local engines have no key. */
export const BYO_PROVIDERS = ['azure', 'sarvam'] as const;

/** Decrypted per-tenant provider credentials, injected by the gateway into tts-v2. */
export type TtsProviderOverrides = Record<string, { api_key: string; region?: string; base_url?: string }>;

/** Nullable spec shape (a tenant OR the SYSTEM-default row). null/[] = inherit. */
export interface TtsSpecInput {
  routingEn?: string[] | null;
  routingMl?: string[] | null;
  allowedProviders?: string[] | null;
  defaultVoiceEn?: string | null;
  defaultVoiceMl?: string | null;
  defaultFormat?: string | null;
  defaultSpeed?: number | null;
  sampleRate?: number | null;
  maxInputChars?: number | null;
  sarvamPublicApiAllowed?: boolean | null;
}

/** Fully-resolved spec — every field concrete, ready to inject into tts-v2. */
export interface EffectiveTtsConfig {
  routingEn: string[];
  routingMl: string[];
  allowedProviders: string[];
  defaultVoiceEn: string;
  defaultVoiceMl: string;
  defaultFormat: string;
  defaultSpeed: number;
  sampleRate: number;
  maxInputChars: number;
  sarvamPublicApiAllowed: boolean;
}

export const PLATFORM_TTS_LIMITS = {
  /** Providers the platform can serve. Tenant routing/whitelist is clamped to this. */
  providerUniverse: ['azure', 'sarvam', 'kokoro', 'indic_parler', 'indic_f5'] as const,
  formats: ['pcm', 'wav', 'mp3'] as const,
  sampleRates: [8000, 16000, 22050, 24000, 44100, 48000] as const,
  speedMin: 0.25,
  speedMax: 4.0,
  maxInputCharsCeiling: 8000,
  codeDefaults: {
    routingEn: ['azure', 'kokoro'],
    routingMl: ['azure', 'sarvam', 'indic_parler'],
    defaultVoiceEn: 'en-female-1',
    defaultVoiceMl: 'ml-female-1',
    defaultFormat: 'pcm',
    defaultSpeed: 1.0,
    sampleRate: 24000,
    maxInputChars: 4096,
    sarvamPublicApiAllowed: false,
  },
} as const;

const PROVIDER_UNIVERSE: ReadonlySet<string> = new Set(PLATFORM_TTS_LIMITS.providerUniverse);
const FORMATS: ReadonlySet<string> = new Set(PLATFORM_TTS_LIMITS.formats);
const SAMPLE_RATES: ReadonlySet<number> = new Set(PLATFORM_TTS_LIMITS.sampleRates);

/** Pick the first "set" value across tenant → system → code default. */
function pickScalar<T>(tenant: T | null | undefined, system: T | null | undefined, code: T): T {
  if (tenant !== null && tenant !== undefined) return tenant;
  if (system !== null && system !== undefined) return system;
  return code;
}

/** Arrays: a non-empty array is "set"; empty/absent inherits the next tier. */
function pickArray(tenant: string[] | null | undefined, system: string[] | null | undefined, code: string[]): string[] {
  if (tenant && tenant.length > 0) return tenant;
  if (system && system.length > 0) return system;
  return code;
}

/**
 * Resolve the effective TTS config for a tenant: tenant row over the SYSTEM
 * default over code defaults, then clamp every value to the platform limits.
 * `allowedProviders` bounds the routing chains; when the Sarvam PHI toggle is
 * off, `sarvam` is stripped from routing + the whitelist (fail-safe).
 */
export function resolveEffectiveTtsConfig(system: TtsSpecInput | null, tenant: TtsSpecInput | null): EffectiveTtsConfig {
  const s = system ?? {};
  const t = tenant ?? {};
  const d = PLATFORM_TTS_LIMITS.codeDefaults;

  const sarvamPublicApiAllowed = pickScalar(t.sarvamPublicApiAllowed, s.sarvamPublicApiAllowed, d.sarvamPublicApiAllowed);

  // Allowed-provider whitelist: clamp to the universe; empty => the full universe.
  const whitelistRaw = pickArray(t.allowedProviders, s.allowedProviders, [...PLATFORM_TTS_LIMITS.providerUniverse]);
  let allowedProviders = whitelistRaw.filter((p) => PROVIDER_UNIVERSE.has(p));
  if (allowedProviders.length === 0) allowedProviders = [...PLATFORM_TTS_LIMITS.providerUniverse];
  if (!sarvamPublicApiAllowed) allowedProviders = allowedProviders.filter((p) => p !== 'sarvam');
  const allowed = new Set(allowedProviders);

  const clampChain = (chain: string[], fallback: string[]): string[] => {
    const filtered = chain.filter((p) => PROVIDER_UNIVERSE.has(p) && allowed.has(p));
    if (filtered.length > 0) return filtered;
    // Fall back to the code default, still clamped to the whitelist.
    const fb = fallback.filter((p) => allowed.has(p));
    return fb.length > 0 ? fb : filtered;
  };

  const routingEn = clampChain(pickArray(t.routingEn, s.routingEn, [...d.routingEn]), [...d.routingEn]);
  const routingMl = clampChain(pickArray(t.routingMl, s.routingMl, [...d.routingMl]), [...d.routingMl]);

  const formatCandidate = pickScalar(t.defaultFormat, s.defaultFormat, d.defaultFormat);
  const defaultFormat = FORMATS.has(formatCandidate) ? formatCandidate : d.defaultFormat;

  const speedCandidate = pickScalar(t.defaultSpeed, s.defaultSpeed, d.defaultSpeed);
  const defaultSpeed = Math.min(Math.max(speedCandidate, PLATFORM_TTS_LIMITS.speedMin), PLATFORM_TTS_LIMITS.speedMax);

  const rateCandidate = pickScalar(t.sampleRate, s.sampleRate, d.sampleRate);
  const sampleRate = SAMPLE_RATES.has(rateCandidate) ? rateCandidate : d.sampleRate;

  const charsCandidate = pickScalar(t.maxInputChars, s.maxInputChars, d.maxInputChars);
  const maxInputChars = charsCandidate > 0 ? Math.min(charsCandidate, PLATFORM_TTS_LIMITS.maxInputCharsCeiling) : d.maxInputChars;

  return {
    routingEn,
    routingMl,
    allowedProviders,
    defaultVoiceEn: pickScalar(t.defaultVoiceEn, s.defaultVoiceEn, d.defaultVoiceEn),
    defaultVoiceMl: pickScalar(t.defaultVoiceMl, s.defaultVoiceMl, d.defaultVoiceMl),
    defaultFormat,
    defaultSpeed,
    sampleRate,
    maxInputChars,
    sarvamPublicApiAllowed,
  };
}
