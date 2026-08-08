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
import { applyTenantScopeExtension, resolveTenantContext } from './extensions/tenant-scope.js';

export * from './generated/core-prisma-client/client.js';
export { Prisma } from './generated/core-prisma-client/client.js';

// Re-export specific error types for convenience
export const {
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
  PrismaClientRustPanicError,
  PrismaClientInitializationError,
  PrismaClientValidationError,
} = Prisma;

// Re-export error types for TypeScript
export type PrismaClientKnownRequestError = Prisma.PrismaClientKnownRequestError;
export type PrismaClientUnknownRequestError = Prisma.PrismaClientUnknownRequestError;
export type PrismaClientRustPanicError = Prisma.PrismaClientRustPanicError;
export type PrismaClientInitializationError = Prisma.PrismaClientInitializationError;
export type PrismaClientValidationError = Prisma.PrismaClientValidationError;

/**
 * Create Prisma Client with PostgreSQL adapter.
 *
 * In Prisma 7, driver adapters own pool sizing — the v6 `connection_limit`
 * URL parameter is ignored. Pool size comes from `PRISMA_PG_MAX` (default 5).
 *
 * Budget rule: `pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections`.
 * At `max_connections = 200` and `max = 5`, HOPE supports up to 28
 * simultaneous pods before approaching the safe ceiling.
 *
 * When DATABASE_URL points at PgBouncer (port 6432 in production), migrations
 * must use DIRECT_URL via `prisma.config.ts` to keep advisory locks intact —
 * they do not survive PgBouncer transaction-mode swaps.
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const rawMax = process.env.PRISMA_PG_MAX;
  const max = rawMax === undefined || rawMax === '' ? 5 : Number(rawMax);
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`PRISMA_PG_MAX must be a positive integer; got ${JSON.stringify(rawMax)}`);
  }

  const adapter = new PrismaPg({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 300_000,
  });

  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
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
  // AsrPipelineVersion is an immutable config-snapshot history
  // table with NO `resourceStatus` column — same shape as the version tables
  // above. Without this entry the soft-delete extension injected
  // `resourceStatus: { not: 'DELETED' }` into every read and Prisma rejected it
  // (PrismaClientValidationError → bare 400 on GET /admin/audio/pipelines/:id/versions).
  'AsrPipelineVersion',
  'DnaUsageRecord',
  'PromptUsageRecord',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
  // TranscriptionJob tracks lifecycle via its own `status` enum (QUEUED →
  // COMPLETED/FAILED/CANCELLED) and has no `resourceStatus` column, so the
  // soft-delete filter would otherwise emit an invalid Prisma `where`.
  'TranscriptionJob',
  // HarnessAuditEvent is an append-only WORM audit table — no
  // `resourceStatus` column and no soft-delete (rows are immutable; the
  // migration REVOKEs UPDATE/DELETE from the app role).
  'HarnessAuditEvent',
  // GateEditExemplar is the derived, append-only gate-edit mining
  // store — no `resourceStatus` column. Rows are pruned/deleted wholesale rather
  // than soft-deleted, so without this entry the soft-delete extension would
  // inject `resourceStatus: { not: 'DELETED' }` and Prisma would reject every
  // read (same failure shape as AsrPipelineVersion above).
  'GateEditExemplar',
  // AgentTrajectoryStep is high-volume ordered ops
  // telemetry with HARD RETENTION (a nightly prune job hard-deletes aged rows)
  // rather than the ENABLED/DELETED soft-delete lifecycle. Like the sibling
  // telemetry tables above it carries NO `resourceStatus` column, so the
  // soft-delete filter must skip it and softDelete()/restore() throw.
  'AgentTrajectoryStep',
  // TranscriptSegment is a per-transcript annotation table (segment
  // structure of a TRANSCRIPT context item). Like its sibling NamedEntity /
  // AudioRecording it has NO `resourceStatus` column — segments live and die
  // with their parent transcript rather than being independently soft-deleted.
  'TranscriptSegment',
  // AI usage metering plane (TASK-615). The ledger and everything
  // derived from it are APPEND-ONLY FACTS under hard retention (18 months raw,
  // rollups indefinite) rather than the ENABLED/DELETED soft-delete lifecycle,
  // so none carries a `resourceStatus` column. Correcting a usage fact is a
  // compensating event, never a delete — these rows are the evidence behind a
  // disputed invoice. `AiPriceBook` is deliberately NOT here: it is the one
  // admin-managed model of that plane and keeps the standard lifecycle.
  'AiUsageEvent',
  'AiUsageOutbox',
  'AiUsageRollupHourly',
  'AiUsageRollupDaily',
  // TASK-638 §6 rule 6 — the provider-reconciliation audit trail. An audit
  // record that can be withdrawn is not a control.
  'ProviderReconciliationRun',
  // A credit memo against a FINALIZED (immutable) invoice.
  // Retracting one by deleting it would rewrite a closed billing period; the
  // correction path is another adjustment. No `resourceStatus` column.
  // `BillingInvoice` / `BillingInvoiceLine` are NOT here — a DRAFT invoice is
  // editable and a withdrawn one is soft-deleted.
  'BillingAdjustment',
  // TenantPlanHistory (TASK-615 #6) — append-only plan-change facts feeding
  // mid-period fee proration. A plan segment is corrected by appending, never by
  // deleting a closed window, so it has no `resourceStatus` column.
  'TenantPlanHistory',
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
/**
 * Apply the shared soft-delete extension to ANY PrismaClient instance.
 *
 * Extracted from the
 * `createExtendedPrismaClient` body so the Vault-backed prisma client
 * (constructed in `apps/api/src/vault-prisma.module.ts`) can reuse the
 * exact same extension config — keeping soft-delete semantics
 * identical across env-mode and vault-mode pods.
 */
/**
 * The subset of a Prisma query-extension callback's parameters this extension uses.
 * Prisma's own generated parameter type is per-model; this narrows it to the fields
 * the soft-delete filter reads.
 */
type SoftDeleteQueryParams = {
  model: string;
  args: { where?: Record<string, unknown> };
  query: (args: { where?: Record<string, unknown> }) => Promise<unknown>;
};

export function applySoftDeleteExtension(prisma: PrismaClient) {
  return prisma.$extends({
    name: 'softDeleteFilter',
    query: {
      $allModels: {
        async findMany({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async findFirst({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async findUnique({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async count({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async aggregate({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        async groupBy({ model, args, query }: SoftDeleteQueryParams) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
      },
    },
  });
}

/**
 * Compose the soft-delete + tenant-scope extensions on top of a raw
 * PrismaClient. Order matters: Prisma walks the chain outermost-first,
 * so applying tenant-scope LAST means its handlers run FIRST — they
 * merge `tenantId` into `args.where` before the soft-delete handler
 * adds `resourceStatus: { not: 'DELETED' }`. The final query the
 * Prisma engine sees carries BOTH filters in a single pass, matching
 * the "defence-in-depth" recommendation
 * (`docs/multi-tenancy-audit/02-prisma-schema-review.md`).
 *
 * The tenant-scope extension reads from `resolveTenantContext()` —
 * which returns the host-registered provider (NestJS wires
 * `TenantContextProvider` from `apps/api/src/database/`) or a
 * permissive fallback for CLI / seed / migration paths.
 */
function createExtendedPrismaClient() {
  const prisma = createPrismaClient();
  const softDeleted = applySoftDeleteExtension(prisma);
  return applyTenantScopeExtension(softDeleted as unknown as PrismaClient, {
    getTenantId: () => resolveTenantContext().tenantId,
    isSuperAdmin: () => resolveTenantContext().isSuperAdmin,
  });
}

// Export types
export type CorePrismaClient = ReturnType<typeof createPrismaClient>;
export type ExtendedCorePrismaClient = ReturnType<typeof createExtendedPrismaClient>;

// Singleton instances
let prismaInstance: CorePrismaClient | null = null;
let extendedPrismaInstance: ExtendedCorePrismaClient | null = null;

/**
 * Get or create the **unscoped, platform-admin** Prisma Client singleton.
 *
 * ⚠️ DANGER — this client BYPASSES the tenant-scope `$extends` and the
 * soft-delete filter. Importing it from a NestJS service is almost
 * certainly a multi-tenancy bug; an ESLint guard blocks
 * the import everywhere except the explicit allow-list:
 *
 *   - `packages/database/src/prisma/db_main/seed/**`
 *   - `packages/database/scripts/**`
 *   - migration runners (`tests/migration/**` once it exists)
 *   - the legacy `baseClient` getter on
 *     `packages/domains/src/common/databaseServices/core/core.database.service.ts`
 *     (transitional; tracked for removal in a follow-up ticket)
 *
 * For every other call site use {@link getExtendedPrismaClient} which
 * returns the composed (soft-delete + tenant-scope) client.
 */
export function getPlatformAdminPrismaClient_Unscoped(): CorePrismaClient {
  if (!prismaInstance) {
    prismaInstance = createPrismaClient();
  }
  return prismaInstance;
}

/**
 * Get or create the extended Prisma Client singleton (default).
 *
 * Composes soft-delete filtering (`applySoftDeleteExtension`) with
 * tenant-scope injection (`applyTenantScopeExtension`). Every NestJS
 * service / repository / controller should use this client.
 */
export function getExtendedPrismaClient(): ExtendedCorePrismaClient {
  if (!extendedPrismaInstance) {
    extendedPrismaInstance = createExtendedPrismaClient();
  }
  return extendedPrismaInstance;
}

/**
 * Create a new raw Prisma Client instance (no extensions, fresh
 * connection pool). Used by tests that need isolated state.
 */
export function createNewPrismaClient(): CorePrismaClient {
  return createPrismaClient();
}

/**
 * Create a new extended Prisma Client instance (composed soft-delete
 * + tenant-scope, fresh connection pool).
 */
export function createNewExtendedPrismaClient(): ExtendedCorePrismaClient {
  return createExtendedPrismaClient();
}

// Default export - the composed (soft-delete + tenant-scope) client
export default getExtendedPrismaClient;
