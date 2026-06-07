/**
 * @arcaai/database - Database package for HOPE Monorepo
 *
 * This package provides:
 * - Prisma Client with PostgreSQL adapter (Prisma 7)
 * - Soft-delete filtering via Client Extensions
 * - Tenant-scope `$extends` (TASK-305 Phase B) composed on top of
 *   soft-delete; pulled from a host-registered context provider.
 * - Database seeding utilities
 *
 * @example
 * // Import the composed client (soft-delete + tenant-scope). Default
 * // path for every NestJS service / repository.
 * import { getExtendedPrismaClient } from '@arcaai/database';
 * const prisma = getExtendedPrismaClient();
 *
 * @example
 * // Import types
 * import type { CorePrismaClient, Prisma } from '@arcaai/database';
 *
 * @example
 * // Register the tenant context provider (NestJS bootstrap)
 * import { setTenantContextProvider } from '@arcaai/database';
 * setTenantContextProvider(myClsBackedProvider);
 *
 * ⚠️ The unscoped client is exported as `getPlatformAdminPrismaClient_Unscoped`
 * — the long name is deliberate; an ESLint rule limits its import to a
 * documented allow-list (see TASK-305 §B.4).
 */

// Re-export client utilities
export {
  applySoftDeleteExtension,
  createNewExtendedPrismaClient,
  createNewPrismaClient,
  getExtendedPrismaClient,
  getPlatformAdminPrismaClient_Unscoped,
  modelHasSoftDelete,
  MODELS_WITHOUT_SOFT_DELETE,
  Prisma,
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
  PrismaClientRustPanicError,
  PrismaClientUnknownRequestError,
  PrismaClientValidationError,
} from './client.js';

export type {
  CorePrismaClient,
  ExtendedCorePrismaClient
} from './client.js';

// TASK-305 Phase B — tenant-scope extension surface.
export {
  applyTenantScopeExtension,
  isSystemSharedReadModel,
  isTenantScopedModel,
  resolveTenantContext,
  setTenantContextProvider,
  SYSTEM_SHARED_READ_MODELS,
  // TASK-330 Phase 6 — reserved system tenant that owns the harness
  // GLOBAL-DEFAULT policy row; the domain `HarnessPolicyRepository`
  // falls back to it when a tenant has no own row.
  SYSTEM_TENANT_ID,
  TENANT_SCOPED_MODELS,
} from './extensions/tenant-scope.js';
export type { TenantContextProvider } from './extensions/tenant-scope.js';

// TASK-302 Phase 5 Task 5.5 (Stream B) — Vault-backed PrismaClient.
export { getPrismaClientWithVault, VaultPrismaClient } from './vault-client.js';
export type {
  DbCredential,
  VaultDbSecretsLike,
  VaultPrismaClientOpts,
} from './vault-client.js';

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
