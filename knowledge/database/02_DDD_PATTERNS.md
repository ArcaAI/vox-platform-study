# Domain-Driven Design Patterns

> **Package**: `@arcaai/domains`
> **Last Updated**: 2026-02-19

---

## Table of Contents

1. [Overview](#overview)
2. [Package Structure](#package-structure)
3. [Entity Hierarchy](#entity-hierarchy)
4. [Change Tracking](#change-tracking)
5. [Factory Pattern](#factory-pattern)
6. [Repository Pattern](#repository-pattern)
7. [Mapper Pattern](#mapper-pattern)
8. [Query Builder Pattern](#query-builder-pattern)
9. [Unit of Work Pattern](#unit-of-work-pattern)
10. [Domain Events](#domain-events)
11. [Code Generation](#code-generation)
12. [Module Configuration](#module-configuration)

---

## Overview

The `@arcaai/domains` package implements Domain-Driven Design patterns for the HOPE monorepo. All domain classes are auto-generated from Prisma schemas using the `@arcaai/tools` code generator, then customized with hand-written extensions where needed.

```text
Application Layer → Repository → Mapper → Database (Prisma)
                                            ↑
                  Factory ──► Entity ────────┘
```

---

## Package Structure

```text
packages/domains/src/
├── common/                            # Base classes and utilities
│   ├── baseEntity/                    # BaseEntity, BaseAggregate, BaseTenantEntity, BaseTaggedEntity
│   ├── baseMapper/                    # BaseMapper abstract class
│   ├── baseModel/                     # BaseDataModel, BaseTenantDataModel
│   ├── autoMappers/                   # AutoClassMapper, AutoEntityMapper, AutoEntityChangeMapper
│   ├── databaseServices/core/         # CoreDatabaseService, CoreDatabaseModule
│   ├── unitsOfWork/core/              # CoreUnitOfWorkService
│   ├── repository.ts                  # Base Repository class
│   ├── queryBuilder.ts                # Fluent query builder
│   └── domainEvent.ts                 # DomainEvent base class
├── entities/generated/core/           # 48 generated entity classes
├── models/generated/core/             # Generated data models (Prisma types)
├── mappers/generated/core/            # 38 generated mapper classes
├── factories/generated/core/          # 46 generated factory classes
├── repositories/generated/core/       # 43 generated repository classes
├── enums/                             # 21 generated + manual enum files
├── interfaces/                        # Interface definitions (IRepository, etc.)
├── events/                            # Domain event definitions
├── middlewares/                        # Custom middleware
└── utils/                             # Utility functions (generateId, etc.)
```

---

## Entity Hierarchy

Domain entities follow a class hierarchy with progressive capabilities:

```text
BaseEntity
    └── BaseAggregate           (+ Domain Events via EventEmitter2)
            └── BaseTenantEntity    (+ tenantId, Tenant relation)
                    └── BaseTaggedEntity    (+ tags[], Tags[])
```

### BaseEntity

The root class for all domain entities.

**Fields**: `id`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy`

**Change Tracking**: Internal `_changes` map recording all property modifications via `setProperty()`.

**Status Lifecycle Methods**:

| Method | Resulting Status |
|--------|-----------------|
| `enable()` | ENABLED |
| `disable()` | DISABLED |
| `archive()` | ARCHIVED |
| `delete()` | DELETED |
| `reinstate()` | DISABLED |
| `recoverFromDelete()` | DISABLED |
| `toggleEnabledDisabled()` | Toggles between ENABLED and DISABLED |

**Status Getters**: `isEnabled`, `isDisabled`, `isDeleted`, `isArchived`, `archivedAt`, `deletedAt`

**Serialization**: `toObject()`, `toRawObject()`, `toJSON()`

**Validation**: `validate()` (abstract — subclasses must implement)

### BaseAggregate

Extends `BaseEntity` with domain event support.

| Method | Description |
|--------|-------------|
| `addEvent(event)` | Queue a domain event |
| `clearEvents()` | Clear the event queue |
| `publishEvents(eventEmitter)` | Emit all queued events via EventEmitter2 |

### BaseTenantEntity

Extends `BaseAggregate` with multi-tenancy.

**Fields**: `tenantId`, `Tenant` (relation entity)

Setting `Tenant` also updates `tenantId` automatically.

### BaseTaggedEntity

Extends `BaseTenantEntity` with tagging.

**Fields**: `tags` (string[]), `Tags` (TagEntity[])

| Method | Description |
|--------|-------------|
| `addTag(tag)` | Add a tag to the entity |
| `removeTag(tag)` | Remove a tag |
| `hasTag(tag)` | Check if tag exists |

### BaseValueObject

Immutable value objects with equality checking.

| Method | Description |
|--------|-------------|
| `equals(other)` | Structural equality comparison |
| `toObject()` | Serialize to plain object |
| `toValue()` | Get raw value |

---

## Change Tracking

All property setters call `setProperty(key, value)`, which records the modification in an internal `_changes` map. This enables efficient partial updates — only changed fields are persisted on `update()`.

```typescript
const user = await userRepository.findById(id);

user.username = 'newname';
user.hasChanges;  // true
user.changes;     // { username: 'newname' }

await userRepository.update(id, user);
// Only { username: 'newname' } is sent to the database

user.clearChanges();
user.hasChanges;  // false
```

The `_changes` map is used by `AutoEntityChangeMapper` to generate minimal Prisma `update()` payloads.

---

## Factory Pattern

Factories create domain entities with proper defaults and ID generation. They are static classes — no dependency injection required.

### Structure

```typescript
class UserFactory {
    static CreateUser(props: CreateUserProps): UserEntity {
        const id = generateId();    // UUIDv7
        const now = new Date();
        return new UserEntity({
            id,
            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            resourceStatus: props.resourceStatus || 'ENABLED',
            // ... map all fields with defaults
        });
    }
}
```

### Default Values

| Field Type | Default |
|------------|---------|
| `id` | `generateId()` (UUIDv7, time-sortable) |
| `createdAt`, `updatedAt` | `new Date()` |
| `resourceStatus` | ENABLED |
| Optional strings | `""` or `null` |
| Optional dates | `new Date()` or `null` |
| Relations | `null` |
| Arrays | `[]` |

### Create Props

All factories extend `BaseEntityFactoryCreateProps` which includes:
- `resourceStatus?` — Override default ENABLED
- `resourceStatusUpdatedAt?`
- `resourceStatusUpdatedBy?`

Entity-specific props define required and optional business fields.

### Usage

```typescript
// Minimal required props
const user = UserFactory.CreateUser({
    username: 'john.doe',
    password: 'hashedPassword',
    isServiceAccount: false,
});

// With audit trail
const user = UserFactory.CreateUser({
    username: 'john.doe',
    password: 'hashedPassword',
    isServiceAccount: false,
    createdBy: currentUserId,
});
```

### Best Practices

1. Always use factories — never construct entities directly with `new`
2. IDs are only generated in factories (centralized)
3. Keep factories simple — complex validation belongs in services
4. Factories are pure/static — no injected dependencies

---

## Repository Pattern

Repositories abstract data persistence behind a consistent interface.

### IRepository Interface

| Method | Description |
|--------|-------------|
| `findAll(props)` | Paginated query with filtering, sorting, search |
| `findById(id)` | Single entity by primary key |
| `findFirst(props)` | First matching entity |
| `count(props)` | Count matching records |
| `create(entity)` | Persist new entity (full `toPersistence()`) |
| `createMany(entities, skipDuplicates?)` | Bulk create |
| `update(id, entity)` | Partial update (only `toPersistenceChanges()` — changed fields) |
| `delete(id)` | Hard delete |
| `softDelete(id, updatedBy?)` | Set `resourceStatus` to DELETED — throws if model lacks `resourceStatus` (see [Soft-Delete Architecture](./03_SOFT_DELETE.md)) |
| `restore(id, updatedBy?)` | Restore a soft-deleted record — throws if model lacks `resourceStatus` |
| `supportsSoftDelete` | Boolean getter — `true` if the model has a `resourceStatus` column |
| `query()` / `$()` | Get a fluent QueryBuilder instance |
| `$bulk(txns)` | Execute bulk operations |
| `rawQuery(query)` | Execute raw SQL (safe, parameterized) |
| `runQuery(queryBuilder)` | Execute a QueryBuilder |

### Base Repository

The abstract `Repository<DomainEntity, DatabaseModel>` class accepts:
- `unitOfWorkService` — Provides database context (extended or transactional client)
- `modelName` — Prisma model name (e.g., `'user'`)
- `mapper` — Entity↔Model mapper singleton
- `includes` — Default relations to include on reads (optional)

Key behaviors:
- `create()` → `mapper.toPersistence()` for full entity mapping
- `update()` → `mapper.toPersistenceChanges()` for only changed fields
- All reads → `mapper.toDomainEntity()` to convert database results to domain entities

### Generated Repository Example

```typescript
@Injectable()
export class UserRepository extends Repository<UserEntity, User> {
    constructor(unitOfWorkService: CoreUnitOfWorkService) {
        super(unitOfWorkService, 'user', UserEntityMapper.getInstance());
    }
}
```

### IFindAllProps

| Property | Type | Description |
|----------|------|-------------|
| `page` | number | Page number (1-based) |
| `limit` | number | Items per page |
| `search` | string | Search term |
| `searchFields` | string[] | Fields to search in (supports nested: `'UserProfile.email'`) |
| `filters` | DbFilters | Complex filter conditions |
| `sort` | Array | Sort order `[{ field: 'asc' | 'desc' }]` |
| `where` | DbFilters | Additional where conditions |

### Filter Operators

`equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `endsWith`, `AND`, `OR`

### Usage

```typescript
// Basic CRUD
const user = await userRepository.findById(id);
const newUser = await userRepository.create(UserFactory.CreateUser({...}));
await userRepository.update(id, modifiedUser);
await userRepository.softDelete(id);

// Pagination with search
const users = await userRepository.findAll({
    page: 1, limit: 10,
    search: 'john',
    searchFields: ['username', 'UserProfile.email'],
    sort: [{ createdAt: 'desc' }],
});

// Complex filtering
const users = await userRepository.findAll({
    filters: {
        AND: [
            { resourceStatus: 'ENABLED' },
            { isServiceAccount: false },
        ],
    },
});
```

---

## Mapper Pattern

Mappers provide bidirectional transformation between domain entities and database models. They are singletons accessed via `getInstance()`.

### BaseMapper

```typescript
abstract class BaseMapper<DomainEntity extends BaseEntity, DataModel> extends Singleton {
    abstract toPersistence(entity: DomainEntity): DataModel;
    abstract toPersistenceChanges(entity: DomainEntity): Partial<DataModel>;
    abstract toDomainEntity(model: DataModel): DomainEntity;
    toDbJson(data: unknown): string | null;
}
```

### Auto Mappers

| Class | Purpose |
|-------|---------|
| `AutoClassMapper` | Maps all properties between types, removes underscore prefixes, applies custom handlers |
| `AutoEntityMapper` | Maps entities using `toObject()`, skips virtual properties (`changes`, `domainEvents`) |
| `AutoEntityChangeMapper` | Maps only changed fields (from `entity.changes`) for efficient partial updates |
| `AutoNestedEntityChange` | Handles nested entity changes, returns `{create?, update?, connect?}` for Prisma |

### Custom Mapper Handlers

Define custom transformations for specific fields using `createMapperHandlers()`:

```typescript
export const UserEntityMapperHandlers = createMapperHandlers<UserEntity, User>({
    $toPersistence: {
        // Custom transformations when saving
    },
    $toDomain: {
        UserProfile: (obj) => obj.UserProfile
            ? UserProfileEntityMapper.getInstance().toDomainEntity(obj.UserProfile)
            : null,
        UserSettings: (obj) => obj.UserSettings?.map(item =>
            UserSettingsEntityMapper.getInstance().toDomainEntity(item)
        ) || [],
    },
});
```

### Mapping Flow

**Create**:
```text
Entity → toPersistence() → Full database model → Prisma create()
```

**Update**:
```text
Entity (with changes) → toPersistenceChanges() → Partial model (changed fields only) → Prisma update()
```

**Read**:
```text
Prisma query result → toDomainEntity() → Domain entity (with nested relation entities)
```

---

## Query Builder Pattern

A fluent, type-safe interface for constructing complex database queries, accessed via `repository.$()`.

### Filtering Methods

| Method | Description |
|--------|-------------|
| `Where(predicate)` | Add AND condition |
| `WhereOr(predicate)` | Add OR condition |
| `WhereAnd(predicate)` | Alias for Where() |
| `WhereNot(predicate)` | Add NOT condition |

### Predicate Syntax

**Simple**: `{ field: value }` or `{ field: { operator: value } }`

**Operators**: `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `endsWith`

**Nested relation**: `{ path: 'Relation.SubRelation', query: { field: value } }`

**Array relation (some)**: `{ path: '$Items', query: {...} }` generates `{ Items: { some: {...} } }`

### Selection and Inclusion

| Method | Description |
|--------|-------------|
| `Select(fields[])` | Select specific fields only |
| `Include(relations)` | Include relations (boolean or nested config) |
| `CountRelation(relation)` | Include count of related records |

### Pagination and Sorting

| Method | Description |
|--------|-------------|
| `Take(limit)` | Limit results |
| `Skip(offset)` | Skip records |
| `OrderBy(fields[], direction)` | Sort by fields ('asc' or 'desc') |

### Execution Methods

| Method | Description |
|--------|-------------|
| `ToList()` | Execute and return array of entities |
| `Single(predicate)` | Return exactly one result (throws if != 1) |
| `Build()` | Return query object without executing |
| `Debug()` | Log query object to console |

### Usage

```typescript
// Basic filtering
const users = await userRepository.$()
    .Where({ username: { contains: 'john' } })
    .Include({ UserProfile: true })
    .OrderBy(['createdAt'], 'desc')
    .Take(10)
    .ToList();

// OR conditions
const admins = await userRepository.$()
    .WhereOr({ username: 'admin' })
    .WhereOr({ isServiceAccount: true })
    .ToList();

// Include relation counts
const consultations = await consultationRepository.$()
    .CountRelation('ContextItems')
    .ToList();
// Result entities include _count.ContextItems

// Nested relation filtering
const users = await userRepository.$()
    .Where({ path: '$UserRoleAssignments.$Role', query: { name: 'DOCTOR' } })
    .ToList();
// Generates: { UserRoleAssignments: { some: { Role: { some: { name: 'DOCTOR' } } } } }
```

---

## Unit of Work Pattern

Manages database transactions and provides consistent database context for repository operations.

### Components

**CoreDatabaseService**: Manages Prisma client lifecycle.
- `client` — Extended Prisma client (soft-delete filtering)
- `baseClient` — Raw Prisma client (bypass soft-delete)
- `query()`, `queryRaw()` — Direct query methods
- NestJS lifecycle hooks (`onModuleInit`, `onModuleDestroy`)

**CoreUnitOfWorkService**: Transaction context via CLS (Continuation-Local Storage).

| Method | Description |
|--------|-------------|
| `startTransaction()` | Begin transaction, store client in CLS |
| `getDatabaseService()` | Return transaction client if active, otherwise extended client |
| `endTransaction()` | Clear transaction context |

### How it Works

Repositories get their database context from the Unit of Work. The `db` getter automatically returns either:
- The **transaction client** (if inside a transaction)
- The **extended Prisma client** (default, with soft-delete filtering)

This is transparent to calling code — the same repository method works with or without an active transaction.

### Without Transaction (Default)

Each repository operation is independent and auto-committed.

### With Transaction

```typescript
try {
    await this.unitOfWork.startTransaction();

    const user = await this.userRepository.create(UserFactory.CreateUser({...}));
    const profile = await this.profileRepository.create(
        UserProfileFactory.CreateUserProfile({ userId: user.id, ... })
    );

    // Both succeed or both roll back
} catch (error) {
    throw error;   // Transaction rolls back
} finally {
    this.unitOfWork.endTransaction();
}
```

### CLS (Continuation-Local Storage)

`nestjs-cls` provides request-scoped storage:
- Each HTTP request has isolated storage
- Transaction client is stored per-request
- Prevents cross-request contamination

---

## Domain Events

Events enable event-driven architecture by allowing entities to publish events that other parts of the system react to.

### DomainEvent Base Class

| Property | Description |
|----------|-------------|
| `id` | Unique event ID (UUIDv7) |
| `entityId` | Related entity ID |
| `domain` | Domain name (e.g., 'user', 'consultation') |
| `props` | Event-specific data (frozen/immutable) |

**Metadata**: `timestamp`, `correlationId`, `causationId`, `responsibleUserId`

### Event Types

**System Events** (`SysEvent`):
- `ResourceCreatedEvent`
- `ResourceViewedEvent`
- `ResourceUpdatedEvent`
- `ResourceDeletedEvent`
- `SendContactMessageEvent`

**Domain Events**:
- `UserCreatedEvent`
- `NotificationSendEvent`

**Event Types Enum** (`EventTypes`): `AppSettingsUpdated`, `NotificationSend`, `ResourceCreated`, `ResourceViewed`, `ResourceUpdated`, `ResourceDeleted`, `MediaCreated`, `MediaUpdated`, `UserAuthenticated`, `UserCreated`, `UserUpdated`, `UserGroupCreated`, `UserGroupUpdated`, `WebhookCreated`, `WebhookUpdated`

### Event Flow

```text
1. Service creates/modifies entity
2. entity.addEvent(new SomeEvent({...}))  — queue event
3. Repository persists entity
4. entity.publishEvents(eventEmitter)      — emit after persistence
5. Event handlers react (sync or async via @OnEvent)
```

### Defining Events

```typescript
class UserCreatedEvent extends DomainEvent<UserCreatedEventProps> {
    constructor(props: BaseDomainEventProps<UserCreatedEventProps>) {
        super({ ...props, domain: 'user' });
    }
}
```

### Handling Events

```typescript
@Injectable()
class UserEventHandler {
    @OnEvent('UserCreatedEvent')
    async handleUserCreated(event: UserCreatedEvent) {
        const props = event.getProps();
        // Audit logging, notifications, etc.
    }
}
```

### Job Queues (BullMQ)

System events flow through BullMQ queues for async processing:

| Queue | Description |
|-------|-------------|
| `AuditLog` | Persist audit trail entries |
| `UserActivity` | Track user activity |
| `SysEvent` | General system event processing |
| `SendEmail` / `SendSms` | Notification delivery |
| `SpeechToText` | Audio transcription jobs |
| `GenerateSummary` | Summary generation |
| `GeneratePreSummary` | Pre-summary generation |
| `GenerateComprehensiveSummary` | Comprehensive summary |
| `ExtractNamedEntities` | NER extraction |
| `GenerateDnaReport` | DNA writing style analysis |
| `WebCrawler` | Web content crawling |

---

## Code Generation

Domain classes are auto-generated from Prisma schemas using `@arcaai/tools`:

```bash
pnpm gen:model          # Generate data models
pnpm gen:entity         # Generate entity classes
pnpm gen:mapper         # Generate mappers
pnpm gen:repository     # Generate repositories
pnpm gen:factory        # Generate factories
pnpm gen:service        # Generate service modules
pnpm gen:controller     # Generate API controllers
```

### Generated File Counts

| Type | Count | Location | Naming Pattern |
|------|-------|----------|---------------|
| Entities | 48 | `entities/generated/core/` | `{Model}Entity.ts` |
| Factories | 46 | `factories/generated/core/` | `{Model}Factory.ts` |
| Repositories | 43 | `repositories/generated/core/` | `{Model}Repository.ts` |
| Mappers | 38 | `mappers/generated/core/` | `{Model}EntityMapper.ts` |
| Models | — | `models/generated/core/` | `{Model}.ts` |
| Enums | 21 | `enums/` | `{EnumName}.ts` |

### Prisma Commander

The `prisma-commander` tool manages schema operations:

```bash
pnpm gen:prisma push --all --force    # Push all schemas
pnpm gen:prisma generate --all        # Generate all clients
```

---

## Module Configuration

### CoreDatabaseModule

The NestJS module that wires everything together:

```typescript
@Module({
    imports: [ClsModule],
    providers: [
        { provide: 'CORE_DATABASE_SERVICE', useClass: CoreDatabaseService },
        CoreUnitOfWorkService,
        UserRepository,
        RoleRepository,
        ConsultationRepository,
        // ... all 43 repositories
    ],
    exports: [/* same providers */],
})
export class CoreDatabaseModule {}
```

### Usage in Application Modules

```typescript
@Module({
    imports: [CoreDatabaseModule],
})
export class ConsultationModule {
    // Repositories are available for injection
}
```

### Importing Domain Types

```typescript
// Specific imports
import { UserEntity, UserFactory, UserRepository } from '@arcaai/domains';

// Namespaced imports
import { DataEntity, DataRepository } from '@arcaai/domains';
```

---

## Related Documentation

- [Data Model & Entity Relationships](./01_DATA_MODEL.md) — Schema definitions, field types, enums, relationships
- [Soft-Delete Architecture](./03_SOFT_DELETE.md) — Model-aware filtering, defense-in-depth layers, troubleshooting
- [Database Package (README)](./README.md) — Client configuration, soft-delete extension, migration workflow
- [Seed Data Reference](./seed-data.md) — Seed constants, execution order, test fixtures
