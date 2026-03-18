# @arcaai/domains

Domain layer package for the HOPE platform, implementing Domain-Driven Design (DDD) patterns with entities, repositories, factories, and mappers shared across all backend applications.

## Overview

The `@arcaai/domains` package implements the domain layer of the HOPE platform following DDD principles. It provides the core business logic abstractions including entity lifecycle management, change tracking, soft-delete support, domain events, and a fluent query builder.

## Structure

- `common/` - Common utilities and shared base classes
- `entities/` - Domain entities with lifecycle management and change tracking
- `enums/` - Enumeration types (resource status, roles, etc.)
- `factories/` - Factory functions for creating domain objects with UUIDv7 IDs
- `interfaces/` - Interface definitions for repositories and services
- `mappers/` - Object mappers for Entity ↔ Prisma model transformations
- `middlewares/` - NestJS middleware functions
- `models/` - Domain model classes
- `repositories/` - Repository implementations with query builder support
- `utils/` - Utility functions

## Usage

```typescript
import { UserEntity, UserFactory, UserRepository } from '@arcaai/domains';

// Create entity via factory
const user = UserFactory.CreateUser({
  username: 'john.doe',
  password: hashedPassword,
  createdBy: currentUserId,
});

// Persist via repository
await userRepository.create(user);

// Query with fluent builder
const users = await userRepository.$()
  .Where({ resourceStatus: 'ENABLED' })
  .OrderBy(['createdAt'], 'desc')
  .Take(20)
  .ToList();
```

## Key Patterns

- **Entity Hierarchy**: `BaseEntity → BaseAggregate → BaseTenantEntity → BaseTaggedEntity`
- **Change Tracking**: Automatic tracking of modified fields for efficient updates
- **Soft Delete**: All entities use `resourceStatus` field instead of hard deletes
- **Domain Events**: Entities emit events for loose coupling between modules
- **Unit of Work**: Transaction support for multi-entity operations

## Dependencies

- `@arcaai/database` - Prisma client and generated types

## License

MIT
