/**
 * Prisma Client Configuration for HOPE Monorepo
 *
 * This module exports a configured PrismaClient instance with:
 * - PostgreSQL driver adapter (@prisma/adapter-pg)
 * - Client extensions for soft-delete filtering
 *
 * ## Environment File Convention:
 * - `.env.dev` → Local development (NODE_ENV=development)
 * - `.env.test` → Local testing (NODE_ENV=test)
 * - `.env.production` → Production reference (NODE_ENV=production uses host env)
 *
 * @module @arcaai/database/client
 */

import { PrismaPg } from '@prisma/adapter-pg';
// Load environment variables using centralized utility
// This respects NODE_ENV to load the correct .env file
import './env.js';
import { Prisma, PrismaClient } from './generated/core-prisma-client/client.js';

// Re-export types and enums from the generated client
export * from './generated/core-prisma-client/client.js';
export { Prisma } from './generated/core-prisma-client/client.js';

// Re-export specific error types for convenience
export const {
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
  PrismaClientRustPanicError,
  PrismaClientInitializationError,
  PrismaClientValidationError
} = Prisma;

// Re-export error types for TypeScript
export type PrismaClientKnownRequestError = Prisma.PrismaClientKnownRequestError;
export type PrismaClientUnknownRequestError = Prisma.PrismaClientUnknownRequestError;
export type PrismaClientRustPanicError = Prisma.PrismaClientRustPanicError;
export type PrismaClientInitializationError = Prisma.PrismaClientInitializationError;
export type PrismaClientValidationError = Prisma.PrismaClientValidationError;

/**
 * Create Prisma Client with PostgreSQL adapter
 *
 * In Prisma 7, driver adapters are required for all database connections.
 * The adapter handles the actual database communication.
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // Create the PostgreSQL adapter with connection string
  const adapter = new PrismaPg({ connectionString });

  // Create Prisma Client with the adapter
  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  });

  return prisma;
}

/**
 * Models that do NOT have a `resourceStatus` column in the database.
 * These are typically immutable records (version history, usage tracking, metadata)
 * where soft-delete semantics don't apply.
 *
 * Keys are PascalCase (matching Prisma's `model` param in client extensions).
 * The lookup also handles camelCase names used by repository constructors.
 *
 * The soft-delete extension must skip these models to avoid Prisma validation errors
 * from filtering on a non-existent column.
 */
export const MODELS_WITHOUT_SOFT_DELETE: ReadonlySet<string> = new Set([
  'ContextItemVersion',
  'PromptVersion',
  'DnaWritingStyleVersion',
  'DnaUsageRecord',
  'PromptUsageRecord',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
]);

/**
 * Check whether a Prisma model supports soft-delete filtering.
 * Accepts both PascalCase ("ContextItemVersion") and
 * camelCase ("contextItemVersion") model names.
 */
export function modelHasSoftDelete(model: string): boolean {
  if (MODELS_WITHOUT_SOFT_DELETE.has(model)) {
    return false;
  }
  const pascalCase = model.charAt(0).toUpperCase() + model.slice(1);
  return !MODELS_WITHOUT_SOFT_DELETE.has(pascalCase);
}

/**
 * Apply soft-delete filter to query args
 * Centralizes the logic for filtering out DELETED records
 *
 * @param args - Query arguments with optional where clause
 *
 * @example
 * // Without explicit resourceStatus - filter is applied
 * applySoftDeleteFilter({ where: { name: 'test' } });
 * // Result: { where: { name: 'test', resourceStatus: { not: 'DELETED' } } }
 *
 * @example
 * // With explicit resourceStatus - filter is NOT applied
 * applySoftDeleteFilter({ where: { resourceStatus: 'DELETED' } });
 * // Result: { where: { resourceStatus: 'DELETED' } }
 */
export function applySoftDeleteFilter(args: { where?: Record<string, unknown> }): void {
  if (!args.where?.resourceStatus) {
    args.where = {
      ...args.where,
      resourceStatus: {
        not: 'DELETED',
      },
    };
  }
}

/**
 * Extended Prisma Client with soft-delete filtering
 *
 * Uses Prisma Client Extensions (replacing the deprecated $use middleware)
 * to automatically filter soft-deleted records.
 *
 * Filtered operations:
 * - findMany: Excludes DELETED records
 * - findFirst: Excludes DELETED records
 * - findUnique: Excludes DELETED records (converts to findFirst internally)
 * - count: Excludes DELETED records
 * - aggregate: Excludes DELETED records
 * - groupBy: Excludes DELETED records
 *
 * To bypass soft-delete filtering, explicitly set resourceStatus in the where clause:
 * - `{ resourceStatus: undefined }` - Include all records
 * - `{ resourceStatus: 'DELETED' }` - Only deleted records
 * - `{ resourceStatus: { in: ['ENABLED', 'DELETED'] } }` - Specific statuses
 */
function createExtendedPrismaClient() {
  const prisma = createPrismaClient();

  // Extend the client with soft-delete filtering.
  // Only applies to models that have a `resourceStatus` column.
  const extendedPrisma = prisma.$extends({
    name: 'softDeleteFilter',
    query: {
      $allModels: {
        async findMany({ model, operation, args, query }) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async findFirst({ model, operation, args, query }) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async findUnique({ model, operation, args, query }) {
          return query(args);
        },
        async count({ model, operation, args, query }) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async aggregate({ model, operation, args, query }) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async groupBy({ model, operation, args, query }) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
      },
    },
  });

  return extendedPrisma;
}

// Export types
export type CorePrismaClient = ReturnType<typeof createPrismaClient>;
export type ExtendedCorePrismaClient = ReturnType<typeof createExtendedPrismaClient>;

// Singleton instances
let prismaInstance: CorePrismaClient | null = null;
let extendedPrismaInstance: ExtendedCorePrismaClient | null = null;

/**
 * Get or create the base Prisma Client instance (singleton)
 */
export function getPrismaClient(): CorePrismaClient {
  if (!prismaInstance) {
    prismaInstance = createPrismaClient();
  }
  return prismaInstance;
}

/**
 * Get or create the extended Prisma Client instance with soft-delete filtering (singleton)
 */
export function getExtendedPrismaClient(): ExtendedCorePrismaClient {
  if (!extendedPrismaInstance) {
    extendedPrismaInstance = createExtendedPrismaClient();
  }
  return extendedPrismaInstance;
}

/**
 * Create a new Prisma Client instance (for cases where you need a fresh connection)
 */
export function createNewPrismaClient(): CorePrismaClient {
  return createPrismaClient();
}

/**
 * Create a new extended Prisma Client instance
 */
export function createNewExtendedPrismaClient(): ExtendedCorePrismaClient {
  return createExtendedPrismaClient();
}

// Default export - the extended client with soft-delete filtering
export default getExtendedPrismaClient;
