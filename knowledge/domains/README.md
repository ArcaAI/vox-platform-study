# @arcaai/domains

Domain-Driven Design (DDD) layer for the HOPE monorepo. This package contains all domain entities, repositories, factories, mappers, models, enums, and shared interfaces that form the core business logic abstraction between the application services and the database.

## Architecture

```
@arcaai/applications (Services)
        │
        ▼
@arcaai/domains
├── Entities      — Business objects with state and behavior
├── Factories     — Entity creation with defaults and ID generation
├── Repositories  — Data access abstraction (CRUD, query builder)
├── Mappers       — Entity ↔ Database model transformations
├── Models        — Database model representations
├── Enums         — Shared enumerations
└── Interfaces    — Contracts and type definitions
        │
        ▼
@arcaai/database (Prisma Client)
```

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/domains` |
| **Version** | `0.0.1` |
| **Runtime** | NestJS 11, TypeScript 5.8 |
| **Key Dependencies** | `@arcaai/database`, `@arcaai/exceptions`, `nestjs-cls`, `uuidv7` |

## Directory Structure

```
packages/domains/src/
├── common/         # Base classes (BaseEntity, BaseMapper, Repository, QueryBuilder, etc.)
├── entities/       # Domain entity definitions (generated + custom)
├── enums/          # Enumeration types
├── factories/      # Factory classes for entity creation
├── integration/    # Integration tests (e.g., repository soft-delete)
├── interfaces/     # Shared interfaces (IFindAllProps, IRepository, etc.)
├── mappers/        # Entity ↔ Model mappers with custom handlers
├── middlewares/    # Domain middleware (e.g., tenant context)
├── models/         # Data model classes mirroring Prisma schema
├── repositories/   # Repository implementations per entity
├── utils/          # Utility functions
└── index.ts        # Barrel exports (direct + namespaced)
```

## Imports

```typescript
// Direct imports
import { UserEntity, UserFactory, UserRepository } from '@arcaai/domains';

// Namespaced imports
import { DataEntity, DataEnum, DataRepository, DataMapper, DataModel } from '@arcaai/domains';

const user: DataEntity.UserEntity = DataEntity.UserEntity;
```

## Entity Pattern

### Entity Hierarchy

```
BaseEntity
    └── BaseAggregate       (+  Domain Events)
            └── BaseTenantEntity  (+  tenantId)
                    └── BaseTaggedEntity  (+  tags[])
```

| Base Class | Adds | Use When |
|------------|------|----------|
| `BaseEntity` | Core fields, change tracking, lifecycle methods, serialization | Simple entities without tenant scope |
| `BaseAggregate` | Domain event queue (`addEvent`, `publishEvents`) | Entities that emit domain events |
| `BaseTenantEntity` | `tenantId`, `Tenant` relation | Multi-tenant scoped entities |
| `BaseTaggedEntity` | `tags[]`, `Tags[]`, tag management methods | Entities that support tagging |

### Core Fields (BaseEntity)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `EntityId` | UUIDv7 identifier |
| `resourceStatus` | `ResourceStatusType` | `ENABLED`, `DISABLED`, `ARCHIVED`, `DELETED` |
| `resourceStatusUpdatedAt` | `Date` | Last status change timestamp |
| `resourceStatusUpdatedBy` | `EntityId` | User who changed the status |
| `createdBy` / `updatedBy` | `EntityId` | Audit trail |
| `createdAt` / `updatedAt` | `Date` | Timestamps |
| `metaData` | `JsonValue` | Flexible JSON metadata |
| `version` | `number` | Optimistic concurrency version |

### Change Tracking

All entity property setters internally call `setProperty()`, which records every modification:

```typescript
const user = await userRepository.findById(id);

user.username = 'new_name';       // tracked
user.disable(currentUserId);       // tracked

user.hasChanges;   // true
user.changes;      // { username: 'new_name', resourceStatus: 'DISABLED', ... }

await userRepository.update(id, user);  // only changed fields are sent to DB
user.clearChanges();
```

### Lifecycle Methods

| Method | Result Status | Description |
|--------|---------------|-------------|
| `enable(updatedBy?)` | `ENABLED` | Activate the entity |
| `disable(updatedBy?)` | `DISABLED` | Temporarily deactivate |
| `archive(updatedBy?)` | `ARCHIVED` | Move to read-only archive |
| `delete(updatedBy?)` | `DELETED` | Soft delete |
| `reinstate(updatedBy?)` | `DISABLED` | Recover from archived |
| `recoverFromDelete(updatedBy?)` | `DISABLED` | Recover from deleted |
| `toggleEnabledDisabled(updatedBy?)` | Toggle | Flip between enabled/disabled |

### Status Checks

`isEnabled`, `isDisabled`, `isArchived`, `isDeleted` — boolean getters.

### Serialization

| Method | Description |
|--------|-------------|
| `toObject()` | Plain object (strips underscore prefixes) |
| `toRawObject()` | Preserves internal field names |
| `toJSON()` | JSON.stringify support |
| `equals(other)` | Identity comparison by ID |

## Factory Pattern

Factories are the **only** way to create new entities. They handle UUIDv7 generation, default values, and timestamp initialization.

```typescript
import { UserFactory } from '@arcaai/domains';

const user = UserFactory.CreateUser({
  username: 'john.doe',
  password: hashedPassword,
  isServiceAccount: false,
  createdBy: currentUserId,
});
```

### Default Values

| Field Type | Default |
|------------|---------|
| `id` | `generateId()` (UUIDv7) |
| `createdAt`, `updatedAt` | `new Date()` |
| `resourceStatus` | `ENABLED` |
| String optionals | `""` or `null` |
| Date optionals | `new Date()` or `null` |
| Relations | `null` |
| Arrays | `[]` |

### Factory Variations

A factory can expose multiple creation methods:

```typescript
UserFactory.CreateUser(props)           // standard creation
UserFactory.CreateServiceAccount(props) // pre-configured for service accounts
```

## Repository Pattern

Repositories provide the data access abstraction between domain entities and the Prisma database.

### IRepository Interface

| Method | Description |
|--------|-------------|
| `findById(id)` | Find entity by primary key |
| `findAll(props)` | Paginated, filtered, sorted query |
| `findFirst(props)` | First matching entity |
| `count(props)` | Count matching records |
| `create(entity)` | Persist a new entity |
| `update(id, entity)` | Update only changed fields |
| `delete(id)` | Hard delete |
| `softDelete(id)` | Soft delete (`resourceStatus → DELETED`) |
| `query()` / `$()` | Get a `QueryBuilder` instance |
| `$bulk(txns)` | Execute bulk operations |

### Repository Example

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
| `page` | `number` | Page number (1-based) |
| `limit` | `number` | Items per page |
| `search` | `string` | Free-text search term |
| `searchFields` | `string[]` | Fields to search (supports nested: `'UserProfile.email'`) |
| `filters` | `DbFilters<T>` | Structured filter conditions |
| `sort` | `Array` | Sort order `[{ field: 'asc' \| 'desc' }]` |
| `where` | `DbFilters<T>` | Additional where conditions |

### Usage Examples

```typescript
// Basic CRUD
const user = await userRepository.findById(id);
const newUser = await userRepository.create(UserFactory.CreateUser({ ... }));
await userRepository.update(id, modifiedUser);
await userRepository.softDelete(id);

// Paginated search
const result = await userRepository.findAll({
  page: 1,
  limit: 10,
  search: 'john',
  searchFields: ['username', 'UserProfile.email'],
  sort: [{ createdAt: 'desc' }],
});

// Complex filtering
const result = await userRepository.findAll({
  filters: {
    AND: [
      { resourceStatus: 'ENABLED' },
      { isServiceAccount: false },
    ],
  },
});
```

### Query Builder

Fluent API for complex queries:

```typescript
const users = await userRepository.$()
  .Where({ resourceStatus: 'ENABLED' })
  .Where({ isServiceAccount: false })
  .Include({ UserProfile: true, UserRoleAssignments: true })
  .OrderBy(['createdAt'], 'desc')
  .Skip(0)
  .Take(20)
  .ToList();
```

| Method | Description |
|--------|-------------|
| `Where(pred)` | AND condition |
| `WhereOr(pred)` | OR condition |
| `WhereNot(pred)` | NOT condition |
| `Include(rels)` | Include relations (eager loading) |
| `OrderBy(fields, dir)` | Sort direction |
| `Take(n)` / `Skip(n)` | Pagination |
| `ToList()` | Execute and return results |

## Mapper Pattern

Mappers handle bidirectional transformation between domain entities and Prisma database models. They are **internal to repositories** and should not be used in the application layer.

```
Domain Entity  ←──── Mapper ────→  Database Model (Prisma)
 (Rich Object)                     (Data Transfer)
```

### BaseMapper Methods

| Method | Direction | Use Case |
|--------|-----------|----------|
| `toPersistence(entity)` | Entity → Model | Creating new records |
| `toPersistenceChanges(entity)` | Entity changes → Partial Model | Updating (only changed fields) |
| `toDomainEntity(model)` | Model → Entity | Reading from database |

### Auto Mapping

- **`AutoClassMapper()`**: Function that automatically maps properties between types, removing underscore prefixes from private fields
- **`AutoEntityChangeMapper()`**: Function that maps only changed properties (`entity.changes`) for efficient partial updates

### Custom Mapper Handlers

For complex transformations like nested relations:

```typescript
export const UserEntityMapperHandlers = createMapperHandlers<UserEntity, User>({
  $toPersistence: {
    // custom transformations for save
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

All mappers use the **singleton pattern** — access via `MyMapper.getInstance()`.

## Domain Events

Aggregate entities can emit events for loose coupling between bounded contexts:

```typescript
// Inside entity or service
this.addEvent(new UserCreatedEvent({
  entityId: this.id,
  props: { username: this.username },
}));

// After successful persistence
await savedUser.publishEvents(this.eventEmitter);

// Event handler (in any module)
@OnEvent('UserCreatedEvent')
async handleUserCreated(event: UserCreatedEvent) {
  // react to user creation
}
```

Events should always be published **after** persistence succeeds, never before.

## Unit of Work / Transactions

For operations that span multiple entities:

```typescript
@Injectable()
export class UserService {
  constructor(
    private readonly unitOfWork: CoreUnitOfWorkService,
    private readonly userRepository: UserRepository,
    private readonly profileRepository: UserProfileRepository,
  ) {}

  async createWithProfile(dto: CreateUserWithProfileDto): Promise<UserEntity> {
    try {
      await this.unitOfWork.startTransaction();
      const user = await this.userRepository.create(/* ... */);
      await this.profileRepository.create(/* ... */);
      return user;
    } finally {
      this.unitOfWork.endTransaction();
    }
  }
}
```

## Module Setup

Import `CoreDatabaseModule` to make all repositories available:

```typescript
@Module({
  imports: [CoreDatabaseModule],
  providers: [UserService],
})
export class UserModule {}
```

## Domain Module Catalog

The `entities/`, `factories/`, `mappers/`, `repositories/`, and `models/` directories are all auto-generated by [`@arcaai/tools`](../tools/README.md) and contain modules for every Prisma model. Key domain modules include:

| Domain | Entities | Description |
|--------|----------|-------------|
| **User** | `UserEntity`, `UserProfileEntity`, `UserSettingsEntity`, `UserGroupEntity`, `UserGroupAssignmentEntity`, `UserRoleAssignmentEntity`, `UserMediaEntity` | User identity, profiles, groups, role bindings |
| **RBAC** | `RoleEntity`, `PermissionEntity`, `RolePermissionEntity` | Role-based access control with CASL permissions |
| **Tenant** | `TenantEntity` | Multi-tenant organization |
| **Consultation** | `ConsultationEntity`, `ContextItemEntity`, `AudioRecordingEntity`, `SummaryMetaEntity`, `NamedEntityEntity`, `ContextItemVersionEntity` | Clinical consultation workflow |
| **STT** | `AiModelEntity`, `AsrPipelineEntity`, `TranscriptionJobEntity` | Speech-to-text AI pipeline |
| **Media** | `MediaEntity` | File management |
| **Department** | `DepartmentEntity` | Department lookup |
| **Notification** | `NotificationEntity` | In-app notifications |
| **ResourceSubscription** | `ResourceSubscriptionEntity` | Resource change subscriptions |
| **Webhook** | `WebhookEntity`, `WebhookRunHistoryEntity` | External webhook endpoints and execution history |
| **Tag** | `TagEntity` | Resource tagging |
| **ApiKey** | `ApiKeyEntity` | API key management |
| **AuditLog** | `AuditLogEntity` | Audit trail |
| **GlobalSetting** | `GlobalSettingEntity` | System-wide settings |
| **PromptTemplate** | `PromptTemplateEntity`, `PromptVersionEntity`, `PromptUsageRecordEntity` | AI prompt templates, versioning, and usage tracking |
| **DnaWritingStyle** | `DnaWritingStyleReportEntity`, `DnaWritingStyleVersionEntity`, `DnaUsageRecordEntity` | Doctor writing style analysis, versions, and usage tracking |

## Code Generation

Use [`@arcaai/tools`](../tools/README.md) to scaffold new domain modules from the Prisma schema:

```bash
# Generate all domain artifacts for a new model
pnpm --filter @arcaai/tools generate-data-entity    # Entity class
pnpm --filter @arcaai/tools generate-data-model     # Data model class
pnpm --filter @arcaai/tools generate-factory        # Factory class
pnpm --filter @arcaai/tools generate-mapper         # Mapper with handlers
pnpm --filter @arcaai/tools generate-repository     # Repository class
```

## Best Practices

| Practice | Description |
|----------|-------------|
| **Use factories** | Never construct entities directly with `new Entity()` |
| **Use soft delete** | Call `softDelete()` instead of `delete()` |
| **Leverage change tracking** | Only changed fields are persisted on `update()` |
| **Use the query builder** | For complex queries over raw Prisma access |
| **Use transactions** | For multi-entity operations via `UnitOfWork` |
| **Publish events after save** | Never before persistence succeeds |
| **Mappers are internal** | Only repositories should use mappers — services work with entities |

## Build

```bash
pnpm build      # Compile TypeScript
pnpm dev        # Watch mode
pnpm lint       # Lint
pnpm typecheck  # Type check without emitting
```

## Related Packages

- [`@arcaai/database`](../database/README.md) — Prisma client and schema (data source)
- [`@arcaai/applications`](../applications/README.md) — Business services that use these repositories
- [`@arcaai/exceptions`](../exceptions/README.md) — Exception classes thrown by repositories
- [`@arcaai/tools`](../tools/README.md) — Code generators for scaffolding domain modules
