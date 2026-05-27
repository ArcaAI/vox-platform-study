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
// eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 allow-list: this is the core-db types module that re-exports the full @arcaai/database surface; consumers go through CoreDatabaseService.client which is already tenant-scoped.
export * as CoreDataModel from '@arcaai/database';

// Symbol for dependency injection
export const ICoreDbClient = Symbol('ICoreDbClient');

// Type alias for the database client interface
export type ICoreDbClientType = import('@arcaai/database').CorePrismaClient;
