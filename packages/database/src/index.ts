/**
 * @arcaai/database - Database package for HOPE Monorepo
 *
 * This package provides:
 * - Prisma Client with PostgreSQL adapter (Prisma 7)
 * - Soft-delete filtering via Client Extensions
 * - Database seeding utilities
 *
 * @example
 * // Import the extended client (with soft-delete filtering)
 * import { getExtendedPrismaClient } from '@arcaai/database';
 * const prisma = getExtendedPrismaClient();
 *
 * @example
 * // Import the base client
 * import { getPrismaClient } from '@arcaai/database';
 * const prisma = getPrismaClient();
 *
 * @example
 * // Import types
 * import type { CorePrismaClient, Prisma } from '@arcaai/database';
 */

// Re-export client utilities
export {
  createNewExtendedPrismaClient, createNewPrismaClient, getExtendedPrismaClient, getPrismaClient, modelHasSoftDelete, MODELS_WITHOUT_SOFT_DELETE, Prisma, PrismaClientInitializationError, PrismaClientKnownRequestError, PrismaClientRustPanicError, PrismaClientUnknownRequestError, PrismaClientValidationError
} from './client.js';

export type {
  CorePrismaClient,
  ExtendedCorePrismaClient
} from './client.js';

// Re-export types and enums from generated client (via auto-generated index)
export * from './generated/core-prisma-client/client.js';

// Seed runner (for CLI usage)
// Environment is loaded automatically by importing env.js
import './env.js';

/**
 * Run database seeding
 * This is called when running `pnpm seed` from the database package
 */
async function runSeed() {
  const { seed } = await import('./prisma/db_main/seed/index.js');
  await seed();
}

// Only run seed if this file is executed directly (ESM equivalent)
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed()
    .then(() => {
      console.log('Database seeding completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Database seeding failed:', error);
      process.exit(1);
    });
}
