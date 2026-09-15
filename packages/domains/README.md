# @arcaai/domains — the DDD entity/repository layer

Domain layer of the HOPE platform, built on top of `@arcaai/database`: entities with change
tracking and lifecycle methods, factories that mint UUIDv7 identities, mappers between entities and
Prisma models, repositories with a fluent query builder, optimistic concurrency, domain events, and
the NestJS `CoreDatabaseModule` that wires it all together.

```
packages/database  ->  packages/domains  ->  packages/applications  ->  apps/api
```

Depends on `@arcaai/database` (Prisma client/types) and `@arcaai/exceptions`. Consumed by
`@arcaai/applications` and `apps/api`. Application services never import `@arcaai/database`
directly — they go through the repositories exported here.

## Layout

| Path | What it holds |
|---|---|
| `src/common/baseEntity/` | `BaseEntity` -> `BaseAggregate` -> `BaseTenantEntity` -> `BaseTaggedEntity` |
| `src/common/baseMapper/` | `BaseMapper<Entity, Model>` contract |
| `src/common/baseModel/` | Base persistence-model classes |
| `src/common/autoMappers/` | `AutoClassMapper` / `AutoEntityChangeMapper` |
| `src/common/databaseServices/core/` | `CoreDatabaseService` + `CoreDatabaseModule` (every repository registered) |
| `src/common/unitsOfWork/core/` | `CoreUnitOfWorkService` (`runInTransaction`) |
| `src/common/events/` | `SysEvent` types, audit-log/notification/user event payloads |
| `src/common/repository.ts` | Generic `Repository<Entity, Model>` base |
| `src/common/queryBuilder.ts` | Fluent `QueryBuilder` (`Where`/`OrderBy`/`Take`/`Include`/`ToList`) |
| `src/common/domainEvent.ts` | `DomainEvent<TProps>` base class |
| `src/common/field-encryption.ts`, `phi-read-decrypt.ts` | PHI field encryption and decrypt-on-read |
| `src/entities/generated/core/` | 101 domain entities (one per Prisma model, as counted in this pass) |
| `src/factories/generated/core/` | Static factories (`XxxFactory.CreateXxx`) |
| `src/mappers/generated/core/` | Entity to Prisma-model mappers |
| `src/models/generated/core/` | Persistence model classes mirroring Prisma shapes |
| `src/repositories/generated/core/` | Generated repositories |
| `src/repositories/{policy,role,role-policy,usage,billing}/` | Hand-written repository trios/extensions outside `generated/` |
| `src/enums/` | `ResourceStatusType`, `SysEventType`, `JobQueue`, `JobType`, and `enums/generated/` (e.g. `ResourceType`) |
| `src/interfaces/` | `IRepository`, `IMapper`, `IFindAllProps`, `IUnitOfWork`, ... |
| `src/middlewares/` | `filterDeleted` middleware |
| `src/utils/` | `generateId` (UUIDv7), `validateEmail`, `harnessAuditHash`, `platformBuckets`, ... |
| `src/integration/` | Suites that need a live Postgres — excluded from the standalone `test` run |

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsc` | `pnpm --filter @arcaai/domains build` |
| Watch | `tsc --watch` | `pnpm --filter @arcaai/domains dev` |
| Test | `vitest run` | `pnpm --filter @arcaai/domains test` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/domains typecheck` |
| Lint | `eslint .` | `pnpm --filter @arcaai/domains lint` |

Unit tests live in `__tests__/` folders next to the code.

## How it works

### Entity hierarchy

| Base class | Adds | Use for |
|---|---|---|
| `BaseEntity` | id, audit fields, `resourceStatus`, change tracking, lifecycle methods, `version` (OCC) | System-level entities without tenancy |
| `BaseAggregate` | domain events (`addEvent`, `publishEvents`) | Aggregates emitting events |
| `BaseTenantEntity` | `tenantId` (validated non-empty) | Tenant-scoped entities |
| `BaseTaggedEntity` | `tags: string[]` | Tenant-scoped entities with tagging |

Entity setters route through `setProperty()`, which records modified fields in `entity.changes`.
`Repository.update()` persists only those changes (via `mapper.toPersistenceChanges`), so always
mutate through setters. Lifecycle methods — `enable()`, `disable()`, `archive()`, `delete()`,
`recoverFromDelete()`, `reinstate()`, `toggleEnabledDisabled()` — set `resourceStatus` plus its
audit fields; every entity implements `validate()`.

### Entity / factory / mapper / repository — a real trio

Department (`entities/generated/core/DepartmentEntity.ts`,
`factories/generated/core/DepartmentFactory.ts`,
`mappers/generated/core/DepartmentEntityMapper.ts`,
`repositories/generated/core/DepartmentRepository.ts`):

```typescript
import { DepartmentFactory, DepartmentRepository } from '@arcaai/domains';

// 1. Factory creates the entity (UUIDv7 id, timestamps, defaults). Never `new XxxEntity()`.
const department = DepartmentFactory.CreateDepartment({
  tenantId,
  code: 'CARD',
  name: 'Cardiology',
  createdBy: currentUserId,
});

// 2. Repository persists it (mapper converts entity to Prisma data under the hood).
const saved = await departmentRepository.create(department);

// 3. Update through setters, then persist only the tracked changes.
saved.name = 'Cardiology & Vascular';
await departmentRepository.update(saved.id, saved);

// 4. Soft delete (sets resourceStatus: DELETED, bumps version).
await departmentRepository.softDelete(saved.id, currentUserId);
```

The mapper (`DepartmentEntityMapper extends BaseMapper`) implements `toPersistence`,
`toPersistenceChanges`, and `toDomainEntity` using the auto-mappers, and strips database-owned
fields (`version`) from write paths. The repository extends `Repository<DepartmentEntity, Department>`
and passes the Prisma delegate name (`'department'`) plus the mapper singleton to the base
constructor; custom finders (`findByCode`, `findRootDepartments`, ...) build on the generic
`findFirst`/`findAll`.

### Repository API

| Method | Behavior |
|---|---|
| `create(entity, tx?)` / `createMany(entities)` | Insert via mapper; optional transaction client |
| `findById(id)` / `findFirst(props)` / `findAll(props)` / `count(props)` | Read with filters/sort/pagination; throw `DataNotFoundException` on misses (`findAll` returns `[]`) |
| `update(id, entity)` | Persist only `entity.changes` |
| `updateWithVersion(id, entity, expectedVersion, tx?)` | Optimistic-concurrency compare-and-set on `_version`; throws `OptimisticConcurrencyException` on drift |
| `softDelete(id, updatedBy?)` / `restore(id, updatedBy?)` | Set `resourceStatus` DELETED/ENABLED and bump version; throws for models in `MODELS_WITHOUT_SOFT_DELETE` |
| `delete(id)` | Hard delete — reserved for genuinely immutable cleanup, avoid outside tests/admin tooling |
| `$()` / `query()` | Fluent `QueryBuilder` |

Reads are automatically decrypt-on-read for registered encrypted PHI columns when a secrets service
is wired (`common/phi-read-decrypt.ts`); in env-mode dev and unit tests this is a pass-through.

```typescript
const rows = await departmentRepository.$().Where({ resourceStatus: 'ENABLED' }).OrderBy(['createdAt'], 'desc').Take(20).ToList();
```

`QueryBuilder` supports `Where` / `WhereOr` / `WhereNot`, `Select`, `OrderBy`, `Take` / `Skip`,
`Include`, `CountRelation`, `Build`, `ToList`, and nested relation paths
(`{ path: 'Parent.$Children', query: {...} }`).

### Transactions

`CoreUnitOfWorkService.runInTransaction(work)` is the canonical transactional API: it opens
`$transaction`, exposes the tx client to nested repository calls through CLS, and rolls back if
`work` throws. The older `startTransaction()` / `endTransaction()` pair is deprecated (it never
carried isolation under Prisma 7) — do not write new callers against it.

```typescript
await this.unitOfWork.runInTransaction(async (tx) => {
  await userRepository.create(user, tx);
  await userRoleAssignmentRepository.create(assignment, tx);
});
```

### Domain events

Define an event extending `DomainEvent<TProps>`, emit from an aggregate with `this.addEvent(event)`,
and publish after successful persistence with `savedEntity.publishEvents(eventEmitter)` (events are
emitted under the event class name). System-event enums and payloads (`SysEventType`, `SysEvent`,
job types) live in `enums/` and `common/events/` and are consumed by `@arcaai/applications` for
audit/webhook fan-out.

### NestJS wiring

`CoreDatabaseModule` (`common/databaseServices/core/core.database.module.ts`) provides and exports
every repository plus `CoreUnitOfWorkService` and `CoreDatabaseService`. Application service
modules import it and constructor-inject repositories directly. New repositories must be registered
there and re-exported from the barrel `index.ts` files.

`SYSTEM_TENANT_ID` is re-exported from `@arcaai/database` so applications-layer code can reference
the reserved system tenant without depending on the database package.

### Adding a new domain model — generator behavior is NOT what the names suggest

After adding a Prisma model in `packages/database`, add the matching artifacts here. The five
`pnpm gen:*` commands behave very differently from each other:

| Command | What it ACTUALLY does |
|---|---|
| `pnpm gen:model` | The only TRUE generator — derives `models/generated/core/*.ts` from the Prisma DMMF and creates files for new models |
| `pnpm gen:entity` / `pnpm gen:factory` | Reconcilers, not scaffolders — they reproduce every COMMITTED file verbatim and run a schema-coverage check. They never create a new entity/factory file |
| `pnpm gen:mapper` | **BROKEN AND DESTRUCTIVE — do not run it.** It crashes partway through but not before rewriting every mapper it already processed, and its output drops the `FIELDS_NOT_WRITABLE = ['version']` strip that stops `_version` leaking into Prisma updates. Recovery is `git checkout -- src/mappers/generated/core/` |
| `pnpm gen:repository` | Broken — fails immediately on a bad CLI argument. Harmless, but useless |

Both `gen:mapper` and `gen:repository` route through `scripts/gen-guard.sh`, which refuses to run
unless the target path is git-clean and requires a typed confirmation — a safety net, not
permission to run `gen:mapper` casually. **Therefore adding a new model means:** run `gen:model`,
then hand-author the entity, factory, mapper, and repository (follow `AiRoutingPolicy*` /
`AiProviderConnection*` as the current hand-authored exemplars), then run `gen:entity` +
`gen:factory` to reconcile barrels and prove schema coverage.

## Gotchas

- Never run `pnpm gen:mapper` — see the table above. If it has already run, `git checkout --
  src/mappers/generated/core/` recovers the mappers; re-add any barrel lines for genuinely new
  models by hand afterward.
- A model that emits sys-events must be added to `ResourceType` in BOTH
  `packages/database/src/prisma/db_main/audit.prisma` (plus an `ALTER TYPE ... ADD VALUE`
  migration) and `src/enums/generated/ResourceType.ts` — skipping this makes every `AuditLog`
  INSERT throw and rolls the originating mutation into a 500.
- `delete(id)` is a real, callable method but is reserved for genuinely immutable cleanup; the
  default for removing a row is `softDelete()`.

## Related

- [`03-domain-layer.md`](../../.claude/rules/03-domain-layer.md) — the full generated-code discipline and new-model checklist this README mirrors
- [`02-database-prisma.md`](../../.claude/rules/02-database-prisma.md) — the Prisma schema this layer maps onto
- [`04-application-services.md`](../../.claude/rules/04-application-services.md) — how `@arcaai/applications` consumes these repositories
- [`@arcaai/database` README](../database/README.md)
