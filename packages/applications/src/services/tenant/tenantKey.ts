import { randomBytes } from 'crypto';

/** Tenant keys are capped at this length (matches the DB column budget). */
const MAX_KEY_LENGTH = 40;

/** Reserved key shape used by platform tenants (`__SYSTEM__`, `__GLOBAL__`, ...). */
const RESERVED_KEY_PATTERN = /^__.+__$/;

/**
 * True when `key` (after trimming) matches the reserved `__*__` shape used by
 * platform-internal tenants (`__SYSTEM__`, `__GLOBAL__`) — TASK-497 D3. Shared
 * by `generateUniqueTenantKey` (auto-generation) and the explicit-key DTO
 * validator (global-admin override).
 */
export function isReservedTenantKeyShape(key: string): boolean {
  return RESERVED_KEY_PATTERN.test(key.trim());
}

/**
 * Slugifies a tenant display name into a `key` candidate: lowercase,
 * `[a-z0-9-]` only, repeated separators collapsed to a single hyphen,
 * leading/trailing hyphens trimmed, capped at `MAX_KEY_LENGTH` (TASK-497 D3).
 */
export function slugifyTenantName(name: string): string {
  return (
    name
      .toLowerCase()
      // Apostrophes are word-joiners, not separators: "mary's" -> "marys".
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, MAX_KEY_LENGTH)
      .replace(/-+$/, '')
  );
}

/** A `t-<8hex>` fallback key for empty or reserved slugs (TASK-497 D3). */
function randomFallbackKey(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

/**
 * Generates a unique tenant `key` from a display name (TASK-497 D3): slugify
 * the name, then probe `exists` and append a numeric collision suffix
 * (`-2`, `-3`, ...) until a free key is found. An empty slug or one matching
 * the reserved `__*__` shape (e.g. `__SYSTEM__`, `__GLOBAL__`) short-circuits
 * to a random `t-<8hex>` key without probing `exists` at all.
 */
export async function generateUniqueTenantKey(name: string, exists: (key: string) => Promise<boolean>): Promise<string> {
  // Checked on the raw name (not the slug): `__*__` never survives
  // slugification (leading/trailing separator runs are trimmed away), so the
  // reserved shape only ever shows up in the caller's original input.
  if (isReservedTenantKeyShape(name)) {
    return randomFallbackKey();
  }

  const base = slugifyTenantName(name);
  if (!base) {
    return randomFallbackKey();
  }

  let candidate = base;
  let suffix = 1;
  while (await exists(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}
