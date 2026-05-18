/**
 * Constants for the Tenant service layer.
 *
 * Centralised here so that the service, controllers, and tests all reference
 * the same literals. Adding new values here is preferred over scattering raw
 * strings throughout the service.
 */

/**
 * Key of the master / global tenant whose `GlobalSetting` rows act as the
 * default configuration template for every newly provisioned tenant.
 *
 * Aligns with the seed defined in
 * `packages/database/src/prisma/db_main/seed/05-tenant.ts`.
 */
export const GLOBAL_TENANT_KEY = '__GLOBAL__';

/**
 * Role name granted to operators with full administrative access. Used as a
 * gate for sensitive tenant-config operations such as editing locked rows or
 * mutating the master `__GLOBAL__` tenant defaults.
 */
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * Generic UUID v1–v7 regex (case-insensitive). Tenant identifiers stored in
 * the database are UUID v7, but we accept any UUID-shaped value to keep the
 * disambiguation logic forgiving of legacy data.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true when the given identifier looks structurally like a UUID and
 * can therefore be used as a primary-key lookup. Non-UUID values are treated
 * as tenant `key` (code-name) lookups.
 */
export function isUuidIdentifier(identifier: string): boolean {
  return typeof identifier === 'string' && UUID_PATTERN.test(identifier);
}
