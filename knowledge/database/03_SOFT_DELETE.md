# Soft-Delete Architecture

> **Packages**: `@arcaai/database` (Prisma extension) + `@arcaai/domains` (Repository + Mapper layer)
> **Last Updated**: 2026-02-22

---

## Table of Contents

1. [Overview](#overview)
2. [Which Models Support Soft-Delete](#which-models-support-soft-delete)
3. [Defense-in-Depth Layers](#defense-in-depth-layers)
4. [Prisma Client Extension](#prisma-client-extension)
5. [Repository Layer Guards](#repository-layer-guards)
6. [Mapper Layer Field Stripping](#mapper-layer-field-stripping)
7. [Adding a New Model](#adding-a-new-model)
8. [Bypassing the Soft-Delete Filter](#bypassing-the-soft-delete-filter)
9. [Known Limitations](#known-limitations)
10. [Testing Strategy](#testing-strategy)
11. [Troubleshooting](#troubleshooting)

---

## Overview

HOPE uses **soft-delete** for most models: instead of physically removing rows, records are marked with `resourceStatus: 'DELETED'` and automatically filtered from read queries. This preserves audit trails and allows restoration.

However, not all models have a `resourceStatus` column. Immutable records like version history, usage tracking, and extracted metadata tables are never soft-deleted. The architecture must handle both cases safely.

The soft-delete system operates at **three layers**, each providing a different type of protection:

```text
┌─────────────────────────────────────────────────────┐
│  Layer 1: Prisma Client Extension (query filtering) │  ← Reads
├─────────────────────────────────────────────────────┤
│  Layer 2: Repository Guards (softDelete/restore)    │  ← Writes
├─────────────────────────────────────────────────────┤
│  Layer 3: Mapper Field Stripping (toPersistence)    │  ← Writes
└─────────────────────────────────────────────────────┘
```

---

## Which Models Support Soft-Delete

### Models WITHOUT `resourceStatus` (immutable records)

These models do **not** have `resourceStatus`, `resourceStatusUpdatedAt`, or `resourceStatusUpdatedBy` columns in their Prisma schema:

| Model | Category | Rationale |
|-------|----------|-----------|
| `ContextItemVersion` | Version history | Immutable snapshot of content at a point in time |
| `PromptVersion` | Version history | Immutable snapshot of prompt template |
| `DnaWritingStyleVersion` | Version history | Immutable snapshot of writing style analysis |
| `DnaUsageRecord` | Usage tracking | Audit record of DNA usage per consultation |
| `PromptUsageRecord` | Usage tracking | Audit record of prompt usage per consultation |
| `AudioRecording` | Immutable record | Binary recording reference, never logically deleted |
| `SummaryMeta` | Metadata | Extracted summary metadata, tied to parent lifecycle |
| `NamedEntity` | Extracted entity | NER extraction result, tied to parent lifecycle |

The authoritative list is maintained in `packages/database/src/client.ts`:

```typescript
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
```

### All other models

Every other model in the `core` schema has `resourceStatus` and participates in soft-delete. This includes `User`, `Consultation`, `ContextItem`, `Department`, `Role`, `Webhook`, etc.

---

## Defense-in-Depth Layers

### Why three layers?

A single check point is fragile. If the Prisma extension is the only guard and someone queries via the base client, deleted records leak. If the mapper is the only guard and someone calls `softDelete()` on a version table, the database throws. Each layer catches a different class of mistake:

| Layer | Protects Against | Location |
|-------|-----------------|----------|
| **Prisma Extension** | Reading deleted records via the extended client | `packages/database/src/client.ts` |
| **Repository Guards** | Calling `softDelete()`/`restore()` on models without `resourceStatus` | `packages/domains/src/common/repository.ts` |
| **Mapper Stripping** | Writing `resourceStatus` fields to models that don't have the column | Each mapper in `packages/domains/src/mappers/generated/core/` |

---

## Prisma Client Extension

**File**: `packages/database/src/client.ts`

The extended Prisma client uses `$allModels` to intercept read operations. Before executing the query, it checks whether the model supports soft-delete:

```typescript
$allModels: {
  async findMany({ model, operation, args, query }) {
    if (modelHasSoftDelete(model)) {
      applySoftDeleteFilter(args);
    }
    return query(args);
  },
  // Same pattern for findFirst, count, aggregate, groupBy
}
```

### `modelHasSoftDelete(model)`

Accepts both PascalCase (`'ContextItemVersion'` — from Prisma extension callbacks) and camelCase (`'contextItemVersion'` — from repository constructors). Returns `true` for any model not in `MODELS_WITHOUT_SOFT_DELETE`.

Unknown models default to `true` (safe default — better to filter a non-existent column, which Prisma will catch, than to silently return deleted records).

### `applySoftDeleteFilter(args)`

Mutates the query args to add `resourceStatus: { not: 'DELETED' }`. Skips if `resourceStatus` is already explicitly set in the where clause (any truthy value bypasses).

### Operations NOT filtered

- **`findUnique`**: Prisma's `findUnique` where clause only accepts unique field values, not complex conditions like `{ not: 'DELETED' }`. Use `findFirst` for soft-delete-aware unique lookups.

---

## Repository Layer Guards

**File**: `packages/domains/src/common/repository.ts`

### `supportsSoftDelete` getter

Every repository exposes a `supportsSoftDelete` boolean that delegates to `modelHasSoftDelete(this._modelName)`:

```typescript
public get supportsSoftDelete(): boolean {
    return modelHasSoftDelete(this._modelName);
}
```

### `softDelete()` and `restore()` guards

Both methods throw immediately if the model doesn't support soft-delete:

```typescript
public async softDelete(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity> {
    if (!this.supportsSoftDelete) {
        throw new Error(
            `softDelete is not supported on model "${this._modelName}" ...`
        );
    }
    // ... proceed with update
}
```

This prevents runtime Prisma errors (which would be cryptic) and gives a clear, actionable error message.

### Usage in application code

```typescript
// Check before calling (optional — the method throws anyway)
if (contextItemVersionRepository.supportsSoftDelete) {
    await contextItemVersionRepository.softDelete(id);
}

// Or just call it and let the guard throw
await contextItemVersionRepository.softDelete(id); // throws Error
```

---

## Mapper Layer Field Stripping

**Files**: Each mapper in `packages/domains/src/mappers/generated/core/`

### The problem

All entities inherit from `BaseEntity`, which has `resourceStatus`, `resourceStatusUpdatedAt`, and `resourceStatusUpdatedBy` as properties. The `AutoClassMapper` maps all entity properties to the persistence model. For models without these database columns, Prisma would reject the extra fields.

### The solution

Each mapper for a model without `resourceStatus` strips these fields in `toPersistence()` and `toPersistenceChanges()`:

```typescript
const FIELDS_NOT_IN_PRISMA: string[] = [
    'createdBy', 'updatedBy', 'updatedAt',
    'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy',
];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
    for (const field of fields) {
        delete (model as Record<string, unknown>)[field];
    }
    return model;
}
```

### Affected mappers

| Mapper | Strips |
|--------|--------|
| `ContextItemVersionEntityMapper` | `createdBy`, `updatedBy`, `updatedAt`, `version`, `resourceStatus*` |
| `PromptVersionEntityMapper` | `createdBy`, `updatedBy`, `updatedAt`, `resourceStatus*` |
| `DnaWritingStyleVersionEntityMapper` | `createdBy`, `updatedBy`, `updatedAt`, `resourceStatus*` |
| `DnaUsageRecordEntityMapper` | `createdBy`, `updatedBy`, `updatedAt`, `resourceStatus*` |
| `PromptUsageRecordEntityMapper` | `createdBy`, `updatedBy`, `updatedAt`, `resourceStatus*` |
| `AudioRecordingEntityMapper` | `resourceStatus*` |
| `SummaryMetaEntityMapper` | `resourceStatus*` |
| `NamedEntityEntityMapper` | `resourceStatus*` |

\* `resourceStatus` = `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy`

---

## Adding a New Model

### If the model HAS `resourceStatus` (standard model)

No special action needed. The Prisma extension will automatically filter it, and the repository's `softDelete()`/`restore()` will work.

### If the model does NOT have `resourceStatus` (immutable/audit record)

1. **Add to `MODELS_WITHOUT_SOFT_DELETE`** in `packages/database/src/client.ts`
2. **Strip fields in the mapper** — add `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy` to `FIELDS_NOT_IN_PRISMA` in the mapper's `toPersistence()` and `toPersistenceChanges()`
3. **Add tests** — update `packages/database/src/__tests__/soft-delete-extension.test.ts` (the `MODELS_WITHOUT_SOFT_DELETE` set assertion will catch missing entries) and `packages/domains/src/mappers/generated/core/__tests__/version-usage-mapper-handlers.test.ts`

### Checklist

- [ ] Prisma schema defined (with or without `resourceStatus`)
- [ ] Model added to `MODELS_WITHOUT_SOFT_DELETE` if no `resourceStatus`
- [ ] Mapper strips `resourceStatus` fields if no `resourceStatus`
- [ ] Tests updated for both extension and mapper
- [ ] `pnpm build` passes (no Prisma validation errors)

---

## Bypassing the Soft-Delete Filter

### Include deleted records in a query

Set `resourceStatus` explicitly in the where clause:

```typescript
const prisma = getExtendedPrismaClient();

// All records regardless of status
const all = await prisma.user.findMany({
  where: { resourceStatus: undefined },
});

// Only deleted records
const deleted = await prisma.user.findMany({
  where: { resourceStatus: 'DELETED' },
});

// Specific statuses
const subset = await prisma.user.findMany({
  where: { resourceStatus: { in: ['ENABLED', 'DELETED'] } },
});
```

### Use the base client (no filtering at all)

```typescript
import { getPrismaClient } from '@arcaai/database';
const basePrisma = getPrismaClient();

// No soft-delete filter applied
const all = await basePrisma.user.findMany();
```

---

## Known Limitations

| Limitation | Workaround |
|-----------|------------|
| `findUnique` does not filter soft-deleted records | Use `findFirst` with the same unique field conditions |
| Entity classes always have `resourceStatus` (from `BaseEntity`) even when the DB doesn't | Mapper stripping removes it before persistence |
| `MODELS_WITHOUT_SOFT_DELETE` is a static set, not derived from Prisma DMMF at runtime | Must be updated manually when adding new models without `resourceStatus` |
| The base client (`getPrismaClient()`) has no soft-delete filtering | Use only for admin/migration scenarios; prefer `getExtendedPrismaClient()` |

---

## Testing Strategy

### Unit tests (no database required)

**`packages/database/src/__tests__/soft-delete-extension.test.ts`** — Tests the pure functions:
- `applySoftDeleteFilter`: filter mutation, bypass with explicit status, falsy value handling
- `modelHasSoftDelete`: PascalCase, camelCase, unknown models, set completeness
- Extension handler contract: verifies the filtering decision matrix across all operations and model types

**`packages/domains/src/mappers/generated/core/__tests__/version-usage-mapper-handlers.test.ts`** — Tests mapper field stripping:
- Each mapper's `toPersistence()` excludes `FIELDS_NOT_IN_PRISMA`
- Each mapper's `toPersistenceChanges()` excludes `FIELDS_NOT_IN_PRISMA`
- Round-trip integrity (`toPersistence` → `toDomainEntity`)

### Integration tests (requires PostgreSQL)

**`packages/database/src/integration/soft-delete.integration.test.ts`** — Tests against a real database:
- Extended client filters DELETED records from `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`
- Base client returns all records including DELETED
- Bypass with explicit `resourceStatus`
- Multi-tenant isolation
- Complex queries (OR, AND, pagination, select)

**`packages/domains/src/integration/repository-soft-delete.integration.test.ts`** — Tests repository operations:
- `softDelete()` sets status to DELETED
- `restore()` sets status to ENABLED
- Soft-deleted records are invisible to `findAll`, `findFirst`, `count`
- Full lifecycle (create → delete → restore)
- Data preservation through delete/restore cycle
- Edge cases (double delete, double restore, timestamp tracking)

### Running tests

```bash
# Unit tests only (fast, no DB needed)
pnpm vitest run packages/database/src/__tests__/soft-delete-extension.test.ts
pnpm vitest run packages/domains/src/mappers/generated/core/__tests__/version-usage-mapper-handlers.test.ts

# Integration tests (requires: pnpm docker:test:up && pnpm test:db:push)
pnpm vitest run packages/database/src/integration/soft-delete.integration.test.ts
pnpm vitest run packages/domains/src/integration/repository-soft-delete.integration.test.ts
```

---

## Troubleshooting

### "Unknown field `resourceStatus` in model X"

**Cause**: The Prisma extension is trying to add `resourceStatus: { not: 'DELETED' }` to a model that doesn't have this column.

**Fix**: Add the model name to `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`.

### "softDelete is not supported on model X"

**Cause**: Application code called `repository.softDelete()` on a model without `resourceStatus`.

**Fix**: This model is an immutable record. Delete it with `repository.delete()` (hard delete) or manage its lifecycle through its parent model.

### Prisma validation error on create/update for version tables

**Cause**: The mapper is sending `resourceStatus` fields to Prisma for a model that doesn't have those columns.

**Fix**: Add `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy` to the `FIELDS_NOT_IN_PRISMA` array in the model's mapper file.

### Deleted records appearing in query results

**Cause**: Either using the base client (`getPrismaClient()`) instead of the extended client, or using `findUnique` which doesn't apply the filter.

**Fix**: Use `getExtendedPrismaClient()` and prefer `findFirst` over `findUnique` when soft-delete filtering is needed.

---

## Related Documentation

- [Database Package (README)](./README.md) — Client configuration, migration workflow
- [Data Model & Entity Relationships](./01_DATA_MODEL.md) — Schema definitions, field types
- [DDD Patterns](./02_DDD_PATTERNS.md) — Repository, Mapper, Entity patterns
- [Seed Data Reference](./seed-data.md) — Seed constants and test fixtures
