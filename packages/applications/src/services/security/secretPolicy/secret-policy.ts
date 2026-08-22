/**
 * Generated-secret policy (pure, DI-free) — the machine-credential sibling of
 * `user/userPassword/password-policy.ts`.
 *
 * Governs the CSPRNG material behind every secret the platform ISSUES to a
 * machine principal: service-account client secrets and API keys. Before this
 * module both were an unconditional `randomBytes(32).toString('hex')` literal
 * in their service — a hardcoded configuration value, which
 * `09-infrastructure-devops.md` §"No hardcoded configuration" forbids.
 *
 * Every knob is overridable through platform `GlobalSetting` rows (namespace
 * `security.secret`, keys below), read through the `AppSettingsService` cache.
 * The stored policy is PREFERRED; these defaults are the last fallback, so an
 * unseeded platform behaves exactly as it did before (32 bytes, hex).
 *
 * FLOOR, NOT A SUGGESTION: `byteLength` is clamped into
 * [`MIN_SECRET_BYTES`, `MAX_SECRET_BYTES`]. A super admin may make an issued
 * secret STRONGER or (down to 16 bytes / 128 bits) cheaper, but no
 * GlobalSetting write can drive platform credentials below the floor — a
 * misconfigured row degrades to the nearest legal value, never to a weak
 * secret.
 */

import { randomBytes } from 'crypto';

export type SecretEncoding = 'hex' | 'base64url';

export interface GeneratedSecretPolicy {
  /** CSPRNG bytes drawn per secret (entropy, not character count). */
  byteLength: number;
  /**
   * Alphabet of the emitted string — the "complexity" dial. `hex` is 4 bits
   * per character; `base64url` is 6, so the same entropy is ~33% shorter.
   * API keys IGNORE this and are always hex (see `API_KEY_ENCODING`).
   */
  encoding: SecretEncoding;
}

/** 128 bits — the floor for any issued credential. */
export const MIN_SECRET_BYTES = 16;
/** 512 bits. Beyond this the extra entropy buys nothing and costs storage. */
export const MAX_SECRET_BYTES = 64;

/** The pre-policy behaviour, preserved exactly: 32 bytes rendered as 64 hex chars. */
export const DEFAULT_GENERATED_SECRET_POLICY: GeneratedSecretPolicy = {
  byteLength: 32,
  encoding: 'hex',
};

/**
 * API keys are PINNED to hex regardless of `policy.encoding`.
 *
 * `ApiKeyService.KEY_FORMAT_REGEX` (`{service}_{type}_[a-f0-9]{32,}_{checksum}`)
 * and `extractChecksum` parse the raw key structurally, and every key already
 * issued matches it. A base64url random part would produce keys that the
 * platform's own validator rejects — so encoding is a service-account-secret
 * dial only, while `byteLength` applies to both.
 */
export const API_KEY_ENCODING: SecretEncoding = 'hex';

/**
 * Storage access keys are PINNED to base64url regardless of `policy.encoding`.
 *
 * These are S3-style credentials whose shipped shape is 32 bytes as 43 url-safe
 * characters, and the platform default encoding is `hex` — so honouring
 * `encoding` here would silently change the credential shape on every
 * deployment that has stored no policy at all, which is exactly the
 * "cataloging changes no behaviour" rule this work is built on. `byteLength`
 * still applies.
 */
export const STORAGE_ACCESS_KEY_ENCODING: SecretEncoding = 'base64url';

/** GlobalSetting keys (platform/SYSTEM tier) that override the defaults. */
export const SECRET_POLICY_SETTING_KEYS = {
  byteLength: 'security.secret.byteLength',
  encoding: 'security.secret.encoding',
} as const;

/** The slice of `IAppSettingsService` the resolver needs (keeps this module pure). */
export interface SecretPolicySettingsReader {
  getValueWithDefault<T>(key: string, defaultValue: T): T;
}

function clampBytes(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECRET_BYTES, Math.max(MIN_SECRET_BYTES, Math.trunc(n)));
}

function toEncoding(value: unknown, fallback: SecretEncoding): SecretEncoding {
  return value === 'hex' || value === 'base64url' ? value : fallback;
}

/** Merge the stored GlobalSetting overrides over the defaults. */
export function resolveGeneratedSecretPolicy(settings: SecretPolicySettingsReader): GeneratedSecretPolicy {
  const d = DEFAULT_GENERATED_SECRET_POLICY;
  return {
    byteLength: clampBytes(settings.getValueWithDefault<unknown>(SECRET_POLICY_SETTING_KEYS.byteLength, d.byteLength), d.byteLength),
    encoding: toEncoding(settings.getValueWithDefault<unknown>(SECRET_POLICY_SETTING_KEYS.encoding, d.encoding), d.encoding),
  };
}

/**
 * Draw one policy-compliant secret. `encodingOverride` exists for the API-key
 * path, which pins hex (`API_KEY_ENCODING`) while still honouring the
 * configured `byteLength`.
 */
export function generateSecretString(policy: GeneratedSecretPolicy, encodingOverride?: SecretEncoding): string {
  return randomBytes(policy.byteLength).toString(encodingOverride ?? policy.encoding);
}
