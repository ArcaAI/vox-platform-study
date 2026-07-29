/**
 * Password complexity + rotation policy (pure, DI-free).
 *
 * Defaults encode the healthcare posture: min 12 chars, upper + lower +
 * digit + special, max 128 (hashing DoS bound; bcrypt only reads 72 bytes
 * anyway). Every knob is overridable through platform `GlobalSetting` rows
 * (namespace `security`, keys below) read via the `AppSettingsService`
 * cache — unseeded keys fall back to these defaults, so no seed is required.
 *
 * Rotation ships OFF (`maxAgeDays = 0`). When an operator raises it, login
 * SURFACES `passwordExpired` (warn) — it never blocks by default, and a NULL
 * `passwordChangedAt` (legacy user) never counts as expired, so nobody is
 * locked out by flipping the knob.
 */

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
  /** Rotation window in days; 0 = rotation disabled. */
  maxAgeDays: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecial: true,
  maxAgeDays: 0,
};

/** GlobalSetting keys (platform tenant) that override the defaults. */
export const PASSWORD_POLICY_SETTING_KEYS = {
  minLength: 'security.password.minLength',
  requireUppercase: 'security.password.requireUppercase',
  requireLowercase: 'security.password.requireLowercase',
  requireDigit: 'security.password.requireDigit',
  requireSpecial: 'security.password.requireSpecial',
  maxAgeDays: 'security.password.maxAgeDays',
} as const;

/** The slice of IAppSettingsService the resolver needs (keeps this module pure). */
export interface PasswordPolicySettingsReader {
  getValueWithDefault<T>(key: string, defaultValue: T): T;
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Merge GlobalSetting overrides (string or typed values) over the defaults. */
export function resolvePasswordPolicy(settings: PasswordPolicySettingsReader): PasswordPolicy {
  const d = DEFAULT_PASSWORD_POLICY;
  return {
    minLength: toInt(settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.minLength, d.minLength), d.minLength),
    maxLength: d.maxLength,
    requireUppercase: toBool(
      settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.requireUppercase, d.requireUppercase),
      d.requireUppercase,
    ),
    requireLowercase: toBool(
      settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.requireLowercase, d.requireLowercase),
      d.requireLowercase,
    ),
    requireDigit: toBool(settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.requireDigit, d.requireDigit), d.requireDigit),
    requireSpecial: toBool(settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.requireSpecial, d.requireSpecial), d.requireSpecial),
    maxAgeDays: toInt(settings.getValueWithDefault<unknown>(PASSWORD_POLICY_SETTING_KEYS.maxAgeDays, d.maxAgeDays), d.maxAgeDays),
  };
}

/**
 * Validate a candidate password against the policy. Returns the list of
 * UNMET rules as user-facing sentences ([] = compliant). The caller joins
 * them into one clear 400 message.
 */
export function validatePasswordComplexity(password: string, policy: PasswordPolicy): string[] {
  const failures: string[] = [];
  const pw = password ?? '';

  if (pw.length < policy.minLength) {
    failures.push(`Password must be at least ${policy.minLength} characters long`);
  }
  if (pw.length > policy.maxLength) {
    failures.push(`Password must be at most ${policy.maxLength} characters long`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(pw)) {
    failures.push('Password must contain at least one uppercase letter (A-Z)');
  }
  if (policy.requireLowercase && !/[a-z]/.test(pw)) {
    failures.push('Password must contain at least one lowercase letter (a-z)');
  }
  if (policy.requireDigit && !/[0-9]/.test(pw)) {
    failures.push('Password must contain at least one number (0-9)');
  }
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(pw)) {
    failures.push('Password must contain at least one special character (e.g. !@#$%)');
  }

  return failures;
}

/**
 * Rotation check surfaced at login. `changedAt` NULL/undefined = legacy or
 * never-tracked → NEVER expired (no lockout by default); `maxAgeDays` 0 =
 * rotation disabled.
 */
export function isPasswordExpired(changedAt: Date | null | undefined, maxAgeDays: number, now: Date = new Date()): boolean {
  if (!maxAgeDays || maxAgeDays <= 0) return false;
  if (!changedAt) return false;
  const ageMs = now.getTime() - changedAt.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}
