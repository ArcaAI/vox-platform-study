# @arcaai/domains

Domain layer of the HOPE platform, implementing DDD patterns on top of `@arcaai/database`: entities with change tracking and lifecycle methods, factories that mint UUIDv7 identities, mappers between entities and Prisma models, repositories with a fluent query builder, optimistic concurrency, domain events, and the NestJS `CoreDatabaseModule` that wires it all together.

Last updated: 2026-07-04

## Position in the stack

```
packages/database  →  packages/domains  →  packages/applications  →  apps/api
```

Depends on `@arcaai/database` (Prisma client/types) and `@arcaai/exceptions`. Consumed by `@arcaai/applications` and `@arcaai/api`. Application services never import `@arcaai/database` directly — they go through the repositories exported here.

## Directory structure

```
src/
├── common/                    # Base classes and shared machinery
│   ├── baseEntity/            # BaseEntity → BaseAggregate → BaseTenantEntity → BaseTaggedEntity
│   ├── baseMapper/            # BaseMapper<Entity, Model> contract
│   ├── baseModel/             # Base persistence-model classes
│   ├── autoMappers/           # AutoClassMapper / AutoEntityChangeMapper
│   ├── databaseServices/core/ # CoreDatabaseService + CoreDatabaseModule (all repos registered)
│   ├── unitsOfWork/core/      # CoreUnitOfWorkService (runInTransaction)
│   ├── events/                # SysEvent types, audit-log/notification/user event payloads
│   ├── repository.ts          # Generic Repository<Entity, Model> base
│   ├── queryBuilder.ts        # Fluent QueryBuilder (Where/OrderBy/Take/Include/ToList)
│   ├── domainEvent.ts         # DomainEvent<TProps> base class
│   ├── field-encryption.ts    # PHI field encryption helpers
│   └── phi-read-decrypt.ts    # Decrypt-on-read wrap for repository delegates
├── entities/generated/core/   # 57 domain entities (one per Prisma model)
├── factories/generated/core/  # Static factories (XxxFactory.CreateXxx)
├── mappers/generated/core/    # Entity ↔ Prisma-model mappers
├── models/generated/core/     # Persistence model classes mirroring Prisma shapes
├── repositories/generated/core/ # Repositories (+ hand-written policy/role/role-policy)
├── enums/                     # ResourceStatusType, SysEventType, JobQueue, JobType, ...
├── interfaces/                # IRepository, IMapper, IFindAllProps, IUnitOfWork, ...
├── middlewares/               # filterDeleted middleware
└── utils/                     # generateId (UUIDv7), validateEmail, harnessAuditHash, ...
```

## Core patterns

### Entity hierarchy

```
BaseEntity → BaseAggregate → BaseTenantEntity → BaseTaggedEntity
```

| Base class | Adds | Use for |
|---|---|---|
| `BaseEntity` | id, audit fields, `resourceStatus`, change tracking, lifecycle methods, `version` (OCC) | System-level entities without tenancy |
| `BaseAggregate` | domain events (`addEvent`, `publishEvents`) | Aggregates emitting events |
| `BaseTenantEntity` | `tenantId` (validated non-empty) | Tenant-scoped entities |
| `BaseTaggedEntity` | `tags: string[]` | Tenant-scoped entities with tagging |

Entity setters route through `setProperty()`, which records modified fields in `entity.changes`. `Repository.update()` persists only those changes (via `mapper.toPersistenceChanges`), so always mutate through setters. Lifecycle methods — `enable()`, `disable()`, `archive()`, `delete()`, `recoverFromDelete()`, `reinstate()`, `toggleEnabledDisabled()` — set `resourceStatus` plus its audit fields; every entity implements `validate()`.

### Entity / factory / mapper / repository — a real trio

Department (`entities/generated/core/DepartmentEntity.ts`, `factories/generated/core/DepartmentFactory.ts`, `mappers/generated/core/DepartmentEntityMapper.ts`, `repositories/generated/core/DepartmentRepository.ts`):

```typescript
import { DepartmentFactory, DepartmentRepository } from '@arcaai/domains';

// 1. Factory creates the entity (UUIDv7 id, timestamps, defaults). Never `new XxxEntity()`.
const department = DepartmentFactory.CreateDepartment({
  tenantId,
  code: 'CARD',
  name: 'Cardiology',
  createdBy: currentUserId,
});

// 2. Repository persists it (mapper converts entity → Prisma data under the hood).
const saved = await departmentRepository.create(department);

// 3. Update through setters, then persist only the tracked changes.
saved.name = 'Cardiology & Vascular';
await departmentRepository.update(saved.id, saved);

// 4. Soft delete (sets resourceStatus: DELETED, bumps version).
await departmentRepository.softDelete(saved.id, currentUserId);
```

The mapper (`DepartmentEntityMapper extends BaseMapper`) implements `toPersistence`, `toPersistenceChanges`, and `toDomainEntity` using the auto-mappers, and strips database-owned fields (`version`) from write paths. The repository extends `Repository<DepartmentEntity, Department>` and passes the Prisma delegate name (`'department'`) plus the mapper singleton to the base constructor; custom finders (`findByCode`, `findRootDepartments`, ...) build on the generic `findFirst`/`findAll`.

### Repository API

| Method | Behavior |
|---|---|
| `create(entity, tx?)` / `createMany(entities)` | Insert via mapper; optional transaction client |
| `findById(id)` / `findFirst(props)` / `findAll(props)` / `count(props)` | Read with filters/sort/pagination; throw `DataNotFoundException` on misses (`findAll` returns `[]`) |
| `update(id, entity)` | Persist only `entity.changes` |
| `updateWithVersion(id, entity, expectedVersion, tx?)` | Optimistic-concurrency compare-and-set on `_version`; throws `OptimisticConcurrencyException` on drift |
| `softDelete(id, updatedBy?)` / `restore(id, updatedBy?)` | Set `resourceStatus` DELETED/ENABLED and bump version; throw if the model has no `resourceStatus` |
| `delete(id)` | Hard delete — avoid outside tests/admin tooling |
| `$()` / `query()` | Fluent `QueryBuilder` |

Reads are automatically decrypt-on-read for registered encrypted PHI columns when a secrets service is wired (`common/phi-read-decrypt.ts`); in env-mode dev and unit tests this is a pass-through.

Query builder example:

```typescript
const rows = await departmentRepository
  .$()
  .Where({ resourceStatus: 'ENABLED' })
  .OrderBy(['createdAt'], 'desc')
  .Take(20)
  .ToList();
```

`QueryBuilder` supports `Where` / `WhereOr` / `WhereNot`, `Select`, `OrderBy`, `Take` / `Skip`, `Include`, `CountRelation`, `Build`, `ToList`, and nested relation paths (`{ path: 'Parent.$Children', query: {...} }`).

### Transactions

`CoreUnitOfWorkService.runInTransaction(work)` is the canonical transactional API: it opens `$transaction`, exposes the tx client to nested repository calls through CLS, and rolls back if `work` throws. The older `startTransaction()` / `endTransaction()` pair is deprecated (it never carried isolation under Prisma 7) — do not write new callers against it.

```typescript
await this.unitOfWork.runInTransaction(async (tx) => {
  await userRepository.create(user, tx);
  await userRoleAssignmentRepository.create(assignment, tx);
});
```

### Domain events

Define an event extending `DomainEvent<TProps>`, emit from an aggregate with `this.addEvent(event)`, and publish after successful persistence with `savedEntity.publishEvents(eventEmitter)` (events are emitted under the event class name). System-event enums and payloads (`SysEventType`, `SysEvent`, job types) live in `enums/` and `common/events/` and are consumed by `@arcaai/applications` for audit/webhook fan-out.

### NestJS wiring

`CoreDatabaseModule` (`common/databaseServices/core/core.database.module.ts`) provides and exports every repository plus `CoreUnitOfWorkService` and `CoreDatabaseService`. Application service modules import it and constructor-inject repositories directly. New repositories must be registered there and re-exported from the barrel `index.ts` files.

`SYSTEM_TENANT_ID` is re-exported from `@arcaai/database` so applications-layer code can reference the reserved system tenant without depending on the database package.

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsc` | `pnpm --filter @arcaai/domains build` |
| Watch | `tsc --watch` | `pnpm --filter @arcaai/domains dev` |
| Test | `vitest run` | `pnpm --filter @arcaai/domains test` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/domains typecheck` |
| Lint | `eslint .` | `pnpm --filter @arcaai/domains lint` |

Unit tests live in `__tests__/` folders next to the code; `src/integration/` holds suites that need a live Postgres and is excluded from the standalone `test` run (see `vitest.config.ts`).

## Adding a new domain model

After adding a Prisma model in `packages/database`, create the matching artifacts here — entity, factory, model, mapper, repository — register the repository in `CoreDatabaseModule`, and update the barrel exports. Generators exist for each artifact: root scripts `pnpm gen:entity`, `pnpm gen:model`, `pnpm gen:mapper`, `pnpm gen:repository`, `pnpm gen:factory` (see `@arcaai/tools`).
