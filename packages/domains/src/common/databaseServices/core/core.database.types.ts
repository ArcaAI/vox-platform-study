/**
 * Core Database Types and Client Export
 *
 * Prisma 7 Changes:
 * - Uses @prisma/adapter-pg for PostgreSQL connections
 * - Middleware ($use) is removed - use Client Extensions instead
 * - Client is generated in @arcaai/database package
 */

// Re-export from the database package
export { PrismaClient as CorePrismaClient, Prisma as CorePrisma } from '@arcaai/database';
// Dropped the `CoreDataModel` wildcard
// alias of `@arcaai/database`. ESLint `no-restricted-imports`
// `importNames` allow-list does not follow wildcard re-exports, so
// the alias was a latent footgun: any consumer reaching for
// `CoreDataModel.getPlatformAdminPrismaClient_Unscoped` (or any
// other raw client entry-point) would silently bypass the
// unscoped-client guard. Verified zero TS consumers before removal.

// Symbol for dependency injection
export const ICoreDbClient = Symbol('ICoreDbClient');

// Type alias for the database client interface
export type ICoreDbClientType = import('@arcaai/database').CorePrismaClient;
