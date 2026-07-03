/**
 * Tenant-key uniqueness validator (DEF-ADM-001). The `key` is set at creation and
 * is immutable thereafter; a case-insensitive client-side check blocks duplicates
 * before the server round-trip (the server remains the source of truth).
 */

export function normalizeTenantKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Case-insensitive membership test. An empty key is "not taken" (caught by required-field validation). */
export function isTenantKeyTaken(key: string, existingKeys: string[]): boolean {
  const normalized = normalizeTenantKey(key);
  if (!normalized) return false;
  return existingKeys.some((k) => normalizeTenantKey(k) === normalized);
}

export interface TenantKeyValidation {
  valid: boolean;
  reason?: 'empty' | 'taken';
}

export function validateTenantKey(key: string, existingKeys: string[]): TenantKeyValidation {
  const normalized = normalizeTenantKey(key);
  if (!normalized) return { valid: false, reason: 'empty' };
  if (isTenantKeyTaken(normalized, existingKeys)) return { valid: false, reason: 'taken' };
  return { valid: true };
}
