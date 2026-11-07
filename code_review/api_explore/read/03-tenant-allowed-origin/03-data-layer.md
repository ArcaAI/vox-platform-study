# 03 — Data layer

> Part of the [tenant-allowed-origin walkthrough](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md).
> **Previous:** [02 — Service rules](./02-service-rules.md) · **Next:** [04 — CORS loop](./04-cors-loop.md)

## 7. Part 4 — The data layer

### 7.1 The repository is a thin subclass

`TenantAllowedOriginRepository` (30–34):

```ts
@Injectable()
export class TenantAllowedOriginRepository extends Repository<TenantAllowedOriginEntity, TenantAllowedOrigin> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantAllowedOrigin', TenantAllowedOriginEntityMapper.getInstance());
  }
}
```

`Repository` is the project's generic base class (`packages/domains/src/common/repository.ts`).
It supplies the methods the service uses:

| Method | Line | Behaviour |
|---|---|---|
| `findById(id)` | 116 | throws `DataNotFoundException` on miss |
| `findByIdOrNull(id)` | 131 | returns `null` on miss |
| `findFirst(props)` | 140 | throws `DataNotFoundException` on miss |
| `findAll(props)` | 152 | returns an array |
| `create(entity)` | 57 | inserts, maps back to an entity |
| `update(id, entity)` | 192 | **no** version predicate |
| `updateWithVersion(id, entity, expected)` | 229 | compare-and-set; throws `OptimisticConcurrencyException` on drift |
| `softDelete(id, updatedBy)` | 335 | sets `DELETED`, bumps `_version` |
| `restore(id, updatedBy)` | 369 | sets `ENABLED`, bumps `_version` |

The `db` getter (line 35) looks up the Prisma delegate by model name
(`this.db.tenantAllowedOrigin`). That is why the constructor passes the string
`'tenantAllowedOrigin'`.

### 7.2 The one custom query

`findByOriginAndTenant` (43–61) is the only hand-written query:

```ts
const where = { origin, tenantId, resourceStatus: ResourceStatusType.ENABLED };
```

It returns a row only for **this** tenant and only if **live**. It says nothing about
other tenants holding the same origin — that is expected. It also cannot see a
soft-deleted row, which is why `create` needs the separate `findDeletedByOriginAndTenant`
lookup that filters on `resourceStatus: DELETED`.

### 7.3 Entity, factory, mapper

| Piece | File | Role |
|---|---|---|
| Entity | `packages/domains/src/entities/generated/core/TenantAllowedOriginEntity.ts` | Domain object; extends `BaseTenantEntity`; tracks `changes`/`hasChanges` |
| Factory | `.../factories/generated/core/TenantAllowedOriginFactory.ts` | `CreateTenantAllowedOrigin` generates a UUIDv7 id and timestamps; services use the factory, not `new` |
| Mapper | `.../mappers/generated/core/TenantAllowedOriginEntityMapper.ts` | entity ↔ Prisma model; **strips `version` from write paths** |
| DTO mapper | `tenant-allowed-origin.dto.mapper.ts` | entity → HTTP response; derives `isPlatform` |

The mapper's `FIELDS_NOT_WRITABLE = ['version']` (line 13) is important. `_version` is
owned by the database; only `updateWithVersion`'s `increment: 1` may change it. If a
buggy caller put `version` in the change set, the mapper removes it.

### 7.4 The Prisma model

`packages/database/src/prisma/db_main/tenant-allowed-origin.prisma:32–85`:

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid(7))` | time-ordered UUID |
| `tenantId` | `String` | owning tenant |
| `origin` | `String` | **stored normalized** |
| `label` | `String` | admin label |
| `description` | `String?` | optional |
| `resourceStatus` | `ResourceStatusType @default(ENABLED)` | soft delete |
| `resourceStatusUpdatedAt/By` | `DateTime?` / `String?` | who deleted/restored |
| `_metadata` | `Json?` | free-form |
| `_version` (`version`) | `Int @default(1)` | OCC |
| `createdBy` / `updatedBy` | `String?` | audit |
| `createdAt` / `updatedAt` | `DateTime` | timestamps |

Constraints:

```prisma
@@unique([origin, tenantId], map: "TenantAllowedOrigin_origin_tenantId_unique")
@@index([tenantId], name: "TenantAllowedOrigin_tenantId_idx")
@@schema("core")
```

- The pair is unique. The same tenant cannot register the same origin twice.
- Two tenants **can** share an origin.
- There is deliberately no standalone `origin` index: the composite unique index
  already covers `origin`-prefixed lookups, and the registry scans every row anyway.

### 7.5 The tenant-scope extension

`packages/database/src/extensions/tenant-scope.ts:283` lists `TenantAllowedOrigin` in
`TENANT_SCOPED_MODELS`. When a CLS tenant exists, the Prisma extension injects
`tenantId` into every read/write against this model. The service **also** filters
explicitly (`where: { tenantId }`), so isolation has two independent layers.

This is also the source of a subtle bug described in
[§8.4](./04-cors-loop.md#84-invalidation-event--refresh): a background job that rebuilds the whole
registry must run **outside** a request's CLS, or the extension will silently narrow
`findAll({})` to one tenant.

### 7.6 How `updateWithVersion` enforces OCC

```ts
const result = await model.updateMany({
  where: { id, version: expectedVersion },
  data: { ...safeChanges, version: { increment: 1 } },
});

if (result.count === 0) {
  const current = await model.findUnique({ where: { id }, select: { version: true } });
  if (!current) throw new DataNotFoundException(...);
  throw new OptimisticConcurrencyException(...);
}
```

This is a single atomic SQL `UPDATE ... WHERE id = ? AND version = ?`. There is no
read-modify-write race: the database decides the winner. On success the version is
incremented; on failure the caller gets the current version in the exception.

### 7.7 NestJS defaults vs project code in this part

| Concern | NestJS / Prisma default | Project code |
|---|---|---|
| Repository | none (you write your own) | generic `Repository<TEntity, TModel>` + generated subclass |
| Entity | none | `BaseTenantEntity`, change tracking |
| Mapping | none | hand-authored mappers, version stripping |
| Soft delete | Prisma `delete` | `resourceStatus` + `softDelete`/`restore` |
| Multi-tenancy | none | `TENANT_SCOPED_MODELS` + CLS extension |
| OCC | none | `_version` + `updateWithVersion` |

---

