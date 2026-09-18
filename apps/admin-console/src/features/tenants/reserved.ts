/**
 * The two RESERVED tenant rows, by their immutable ids.
 *
 * `00000000-…` is the SYSTEM configuration tier every other tenant inherits
 * from on absence; `50000000-…` is "Global", the platform-admin playground
 * (a CUSTOMER tenant, never a config tier — `00-project-context.md`
 * §"The two reserved tenants are NOT two config tiers").
 *
 * TASK-986 W1 — the gateway refuses every suspend / archive / delete AND every
 * PATCH against these rows with a 403 (owner ruling D-5). The console mirrors
 * that so the operator never fires an action that can only fail; the server
 * stays the enforcement point. Matching is by ID, never by `key`: `key` is
 * writable, which is precisely how the old key-only guard was disarmable.
 */
export const RESERVED_TENANT_IDS = ['00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000000'] as const;

/** Visible reason shown wherever a reserved row's actions are withheld (rule 11 §7). */
export const RESERVED_TENANT_REASON = 'Protected platform tenant — it cannot be edited, suspended, archived or deleted.';

export function isReservedTenant(id: string | null | undefined): boolean {
  return !!id && (RESERVED_TENANT_IDS as readonly string[]).includes(id);
}
