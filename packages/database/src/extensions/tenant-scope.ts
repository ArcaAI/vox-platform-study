/**
 * Tenant-Scope Prisma `$extends` Extension — TASK-305 Phase B.
 *
 * This extension injects `tenantId` from a caller-supplied context
 * provider into every read/write against a tenant-scoped model. It is
 * the second line of defence behind the database-level Row-Level
 * Security policies that ship in Phase C; together they form the
 * "defence in depth" multi-tenancy posture mandated by the audit
 * (`docs/multi-tenancy-audit/02-prisma-schema-review.md` §B7).
 *
 * Composition: applied AFTER `applySoftDeleteExtension` so the
 * tenant filter sees the soft-delete-augmented args (Prisma runs the
 * outermost extension first; the chain is
 *   prisma -> softDelete -> tenantScope -> engine
 * which means the tenantScope handler runs first, merges `tenantId`
 * into `args.where`, then hands off to the soft-delete handler which
 * adds `resourceStatus: { not: 'DELETED' }` on the same `where`).
 *
 * Out-of-scope (kept invisible to NestJS callers):
 *   - Cross-aggregate tenant equality (parent.tenantId vs child) —
 *     handled by Phase D guards.
 *   - `SET LOCAL app.tenant_id` for RLS — owned by Phase C.
 *
 * @see docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md
 */

import { PrismaClient } from '../generated/core-prisma-client/client.js';

// ---------------------------------------------------------------------------
// Allow-list of tenant-scoped models
// ---------------------------------------------------------------------------

/**
 * Models that carry a `tenantId` column in `packages/database/src/prisma/db_main/*.prisma`.
 *
 * Derived from a manual sweep of the schema at the time of writing
 * (TASK-305 Phase B, 2026-05). The audit (`docs/multi-tenancy-audit/
 * 02-prisma-schema-review.md` §A) lists 30 model names; 4 of those
 * (`UserProfile`, `UserSettings`, `UserMedia`, `UserVoiceProfile`) and
 * `DnaRegenerationSettings` do NOT yet carry a `tenantId` column —
 * they will be added when Phase A's schema-hardening migration lands.
 * Until then this allow-list mirrors the schema reality (27 entries),
 * NOT the future plan; that way the extension never tries to inject
 * `tenantId` on a column that doesn't exist.
 *
 * When Phase A adds the missing columns, the allow-list MUST be
 * extended in the same commit (tracked by Phase A.10/A.11 codegen).
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  // consultation.prisma (6)
  'Consultation',
  'ContextItem',
  'ContextItemVersion',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
  // audit.prisma (1)
  'AuditLog',
  // webhook.prisma (1)
  'Webhook',
  // notification.prisma (2)
  'Notification',
  'ResourceSubscription',
  // tag.prisma (1)
  'Tag',
  // apikey.prisma (1)
  'ApiKey',
  // globalSetting.prisma (1)
  'GlobalSetting',
  // stt.prisma (3)
  'AsrPipeline',
  'AiModel',
  'TranscriptionJob',
  // department.prisma (1)
  'Department',
  // user.prisma (1)
  'UserRoleAssignment',
  // dna-writing-style.prisma (4)
  'DnaWritingStyleReport',
  'DnaWritingStyleVersion',
  'DnaUsageRecord',
  'PromptUsageRecord',
  // prompt-template.prisma (2)
  'PromptTemplate',
  'PromptVersion',
  // tenant-bucket.prisma (2)
  'TenantBucket',
  'StorageAccessKey',
  // media.prisma (1)
  'Media',
]);

/**
 * `model` arrives via `$allModels` in both Pascal and camel case
 * depending on which Prisma surface dispatched the query. Accept both.
 */
export function isTenantScopedModel(model: string): boolean {
  if (TENANT_SCOPED_MODELS.has(model)) return true;
  const pascal = model.charAt(0).toUpperCase() + model.slice(1);
  return TENANT_SCOPED_MODELS.has(pascal);
}

// ---------------------------------------------------------------------------
// Context provider — singleton registered by the host application
// ---------------------------------------------------------------------------

/**
 * Pluggable provider that returns the *current* tenant id (typically
 * from `nestjs-cls`) and optionally signals whether the caller carries
 * the SUPER_ADMIN role (cross-tenant audit / platform-admin paths).
 *
 * The provider is intentionally framework-agnostic so this package
 * does not have to depend on `nestjs-cls`. NestJS wires its CLS-backed
 * implementation in `apps/api/src/database/tenant-context.provider.ts`
 * (Phase B.7).
 */
export interface TenantContextProvider {
  getTenantId(): string | null | undefined;
  isSuperAdmin?(): boolean;
}

let providerSingleton: TenantContextProvider | null = null;

/**
 * Register (or clear) the global tenant-context provider that
 * `createExtendedPrismaClient` consults on every query.
 *
 * Pass `null` to unregister (used in test teardown and on graceful
 * shutdown so the extension goes back to "no provider = pass-through"
 * behaviour required by seed scripts and one-shot CLI tools).
 */
export function setTenantContextProvider(
  provider: TenantContextProvider | null,
): void {
  providerSingleton = provider;
}

/**
 * Internal lookup used by the composed extension in `client.ts`.
 * Falls back to a permissive "no provider = pass-through" stance so
 * seed scripts, migrations and CLI tools that import the singleton
 * before NestJS wiring runs do not blow up.
 */
export function resolveTenantContext(): {
  tenantId: string | null | undefined;
  isSuperAdmin: boolean;
} {
  if (!providerSingleton) {
    return { tenantId: undefined, isSuperAdmin: true };
  }
  return {
    tenantId: providerSingleton.getTenantId(),
    isSuperAdmin: providerSingleton.isSuperAdmin?.() ?? false,
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

interface ApplyTenantScopeOptions {
  getTenantId: () => string | null | undefined;
  isSuperAdmin?: () => boolean;
}

interface QueryParams {
  model: string;
  args: Record<string, unknown>;
  query: (a: unknown) => Promise<unknown>;
}

/**
 * Apply the tenant-scope `$extends` to any PrismaClient (raw or already
 * extended). Use options.getTenantId / isSuperAdmin to wire the lookup
 * directly; `client.ts` passes a delegating closure that reads from
 * `resolveTenantContext()` so a single singleton provider drives every
 * extended client in the process.
 */
export function applyTenantScopeExtension(
  prisma: PrismaClient,
  options: ApplyTenantScopeOptions,
) {
  const ctx = () => {
    const tenantId = options.getTenantId();
    const isSuperAdmin = options.isSuperAdmin?.() ?? false;
    return { tenantId, isSuperAdmin };
  };

  // Read ops merge into args.where (or seed it). Build a per-op handler
  // that records the right op label in the thrown error message.
  const makeReadHandler = (op: string) => async (params: QueryParams) => {
    if (!isTenantScopedModel(params.model)) {
      return params.query(params.args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return params.query(params.args);
      throw new Error(
        `TenantScope: tenant context required for model ${params.model} operation ${op}`,
      );
    }
    mergeTenantIntoWhere(params.args, tenantId, params.model, op);
    return params.query(params.args);
  };

  // create / upsert mutate args.data (and where for upsert)
  const createHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation create`,
      );
    }
    enforceTenantInData(args, 'data', tenantId, model, 'create');
    return query(args);
  };

  const createManyHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation createMany`,
      );
    }
    const data = args.data;
    if (Array.isArray(data)) {
      args.data = data.map((row, index) =>
        applyTenantToRecord(row as Record<string, unknown>, tenantId, model, `createMany[${index}]`),
      );
    } else if (data && typeof data === 'object') {
      args.data = applyTenantToRecord(data as Record<string, unknown>, tenantId, model, 'createMany');
    }
    return query(args);
  };

  const upsertHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation upsert`,
      );
    }
    mergeTenantIntoWhere(args, tenantId, model, 'upsert');
    enforceTenantInData(args, 'create', tenantId, model, 'upsert.create');
    return query(args);
  };

  // update / updateMany / delete / deleteMany merge tenantId into where.
  const mutateWhereHandler = (op: string) => async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation ${op}`,
      );
    }
    mergeTenantIntoWhere(args, tenantId, model, op);
    return query(args);
  };

  // The Prisma 7 typing for `query.$allModels` is the intersection of
  // operations across every model. Because the schema enables the
  // `views` preview feature, view-backed models don't expose
  // `create` / `createMany` / `createManyAndReturn`, so those keys
  // disappear from the intersection's typed surface. The runtime
  // contract still accepts them on regular models — Prisma dispatches
  // by operation string at call time — so we cast the handler bag to
  // bypass the type-level exclusion. This pattern matches the soft-
  // delete extension's `({ model, args, query }: any)` cast style.
  const handlers = {
    // Read
    findFirst: makeReadHandler('findFirst'),
    findFirstOrThrow: makeReadHandler('findFirstOrThrow'),
    findUnique: makeReadHandler('findUnique'),
    findUniqueOrThrow: makeReadHandler('findUniqueOrThrow'),
    findMany: makeReadHandler('findMany'),
    count: makeReadHandler('count'),
    aggregate: makeReadHandler('aggregate'),
    groupBy: makeReadHandler('groupBy'),
    // Write
    create: createHandler,
    createMany: createManyHandler,
    upsert: upsertHandler,
    update: mutateWhereHandler('update'),
    updateMany: mutateWhereHandler('updateMany'),
    delete: mutateWhereHandler('delete'),
    deleteMany: mutateWhereHandler('deleteMany'),
  };

  return prisma.$extends({
    name: 'tenantScopeFilter',
    query: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $allModels: handlers as any,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (kept module-private; surface is the factory above)
// ---------------------------------------------------------------------------

function mergeTenantIntoWhere(
  args: Record<string, unknown>,
  tenantId: string,
  model: string,
  op: string,
): void {
  const where = (args.where ?? {}) as Record<string, unknown>;
  if ('tenantId' in where && where.tenantId !== undefined) {
    if (where.tenantId !== tenantId) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(where.tenantId)} but context is ${JSON.stringify(tenantId)}`,
      );
    }
    args.where = where;
    return;
  }
  args.where = { ...where, tenantId };
}

function enforceTenantInData(
  args: Record<string, unknown>,
  field: 'data' | 'create',
  tenantId: string,
  model: string,
  op: string,
): void {
  const payload = args[field];
  if (!payload || typeof payload !== 'object') {
    // Nothing to inject into — leave it for Prisma to reject.
    return;
  }
  args[field] = applyTenantToRecord(payload as Record<string, unknown>, tenantId, model, op);
}

function applyTenantToRecord(
  record: Record<string, unknown>,
  tenantId: string,
  model: string,
  op: string,
): Record<string, unknown> {
  if ('tenantId' in record && record.tenantId !== undefined && record.tenantId !== null) {
    if (record.tenantId !== tenantId) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(record.tenantId)} but context is ${JSON.stringify(tenantId)}`,
      );
    }
    return record;
  }
  return { ...record, tenantId };
}
