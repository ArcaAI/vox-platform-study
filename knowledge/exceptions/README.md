# @arcaai/exceptions

Custom exception hierarchy for the HOPE monorepo. Provides structured, serializable exception classes organized into application, persistence, and domain layers. All exceptions carry a correlation ID for distributed tracing.

## Architecture

```
BaseException (abstract)
├── Application Exceptions     → HTTP 4xx / 5xx responses
├── BasePersistenceException   → Database operation failures
│   └── Persistence Exceptions
└── BaseDomainException        → Business rule violations
    └── Domain Exceptions
```

Every exception extends `BaseException`, which captures:
- **Error code** — constant string for cross-process identification
- **Correlation ID** — automatically read from `nestjs-cls` continuation-local storage
- **Serialization** — `toJSON()` produces a structured payload (stack trace omitted in production)

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/exceptions` |
| **Version** | `0.0.1` |
| **Runtime** | TypeScript 5.8 |
| **Key Dependency** | `nestjs-cls` (for correlation ID) |

## Base Classes

### BaseException

The root abstract class for all custom exceptions.

```typescript
abstract class BaseException extends Error {
  abstract code: string;
  readonly correlationId: string;

  constructor(message: string, cause?: Error, metadata?: unknown);
  toJSON(): SerializedException;
}
```

`SerializedException` shape:

```typescript
interface SerializedException {
  message: string;
  code: string;
  correlationId: string;
  stack?: string;       // omitted in production
  cause?: string;
  metadata?: unknown;
}
```

### BasePersistenceException

Base for all database/persistence layer exceptions. Accepts an explicit `code` string.

```typescript
abstract class BasePersistenceException extends BaseException {
  constructor(message: string, code: string, cause?: Error, metadata?: unknown);
}
```

### BaseDomainException

Base for all domain/business rule exceptions.

```typescript
abstract class BaseDomainException extends BaseException {
  constructor(message: string, code: string, cause?: Error, metadata?: unknown);
}
```

## Exception Classes

### Application Exceptions

Thrown from the application/service layer for request validation and authorization failures.

| Exception | Code | Default Message | Typical HTTP Status |
|-----------|------|-----------------|---------------------|
| `ArgumentInvalidException` | `GENERIC.ARGUMENT_INVALID` | The provided argument(s) are invalid. | 400 |
| `ArgumentNotProvidedException` | `GENERIC.ARGUMENT_NOT_PROVIDED` | Expected argument not provided. | 400 |
| `ArgumentOutOfRangeException` | `GENERIC.ARGUMENT_OUT_OF_RANGE` | Argument is out of the expected range. | 400 |
| `NotFoundException` | `GENERIC.NOT_FOUND` | The requested resource was not found. | 404 |
| `ConflictException` | `GENERIC.CONFLICT` | Conflict detected, operation cannot be completed. | 409 |
| `UnauthorizedException` | `UNAUTHORIZED` | Unauthorized | 401 |
| `InternalServerErrorException` | `GENERIC.INTERNAL_SERVER_ERROR` | An unexpected internal server error has occurred. | 500 |

### Persistence Exceptions

Thrown from the repository/database layer for data access failures.

| Exception | Code | Default Message | Typical HTTP Status |
|-----------|------|-----------------|---------------------|
| `DataNotFoundException` | `PERSISTENCE.DATA_NOT_FOUND` | `[DB] {Entity} with ID {id} could not be found.` | 404 |
| `DataCreationException` | `PERSISTENCE.DATA_CREATION_FAILED` | `[DB] Could not create {Entity}` | 500 |
| `DataConflictException` | `PERSISTENCE.DATA_CONFLICT` | Data conflict occurred in the database. | 409 |
| `DatabaseConnectionException` | `PERSISTENCE.DATABASE_CONNECTION_FAILED` | Failed to connect to the database. | 503 |
| `QueryFailedException` | `PERSISTENCE.QUERY_FAILED` | Database query failed to execute. | 500 |
| `TransactionFailedException` | `PERSISTENCE.TRANSACTION_FAILED` | Database transaction failed. | 500 |

### Domain Exceptions

Thrown from entity or domain logic for business rule violations.

| Exception | Code | Default Message | Typical HTTP Status |
|-----------|------|-----------------|---------------------|
| `BusinessException` | `DOMAIN.BUSINESS` | *(custom message required)* | 422 |

## Exception Codes

All codes are defined as constants for cross-process sharing:

```typescript
// Application layer
export const ARGUMENT_INVALID = 'GENERIC.ARGUMENT_INVALID';
export const ARGUMENT_OUT_OF_RANGE = 'GENERIC.ARGUMENT_OUT_OF_RANGE';
export const ARGUMENT_NOT_PROVIDED = 'GENERIC.ARGUMENT_NOT_PROVIDED';
export const NOT_FOUND = 'GENERIC.NOT_FOUND';
export const CONFLICT = 'GENERIC.CONFLICT';
export const INTERNAL_SERVER_ERROR = 'GENERIC.INTERNAL_SERVER_ERROR';
export const UNAUTHORIZED = 'UNAUTHORIZED';

// Domain layer
export const BUSINESS = 'DOMAIN.BUSINESS';

// Persistence layer
export const DATA_CONFLICT = 'PERSISTENCE.DATA_CONFLICT';
export const DATABASE_CONNECTION_FAILED = 'PERSISTENCE.DATABASE_CONNECTION_FAILED';
export const DATA_CREATION_FAILED = 'PERSISTENCE.DATA_CREATION_FAILED';
export const QUERY_FAILED = 'PERSISTENCE.QUERY_FAILED';
export const DATA_NOT_FOUND = 'PERSISTENCE.DATA_NOT_FOUND';
export const TRANSACTION_FAILED = 'PERSISTENCE.TRANSACTION_FAILED';
```

## Usage Examples

### Throwing Application Exceptions

```typescript
import {
  ArgumentInvalidException,
  NotFoundException,
  ConflictException,
} from '@arcaai/exceptions';

// Invalid argument
if (!dto.username) {
  throw new ArgumentInvalidException('Username is required');
}

// Resource not found
const user = await this.userRepository.findById(id);
if (!user) {
  throw new NotFoundException(`User with ID ${id} not found`);
}

// Conflict
const existing = await this.userRepository.findFirst({ username: dto.username });
if (existing) {
  throw new ConflictException(`Username "${dto.username}" is already taken`);
}
```

### Throwing Persistence Exceptions

Persistence exceptions are typically thrown inside repositories:

```typescript
import { DataNotFoundException, DataCreationException } from '@arcaai/exceptions';

// Entity not found in database
throw new DataNotFoundException('User', userId);
// → "[DB] User with ID abc-123 could not be found."

// Creation failure
try {
  await prisma.user.create({ data });
} catch (error) {
  throw new DataCreationException('User', error);
}
```

### Throwing Domain Exceptions

```typescript
import { BusinessException } from '@arcaai/exceptions';

if (consultation.isArchived) {
  throw new BusinessException('Cannot modify an archived consultation');
}
```

## Integration with NestJS

### Exception Filters

The API gateway registers a global exception filter that maps custom exceptions to HTTP responses:

```typescript
@Catch(BaseException)
export class BaseExceptionFilter implements ExceptionFilter {
  catch(exception: BaseException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const statusCode = this.mapCodeToStatus(exception.code);

    response.status(statusCode).json(exception.toJSON());
  }

  private mapCodeToStatus(code: string): number {
    const mapping: Record<string, number> = {
      'GENERIC.ARGUMENT_INVALID': 400,
      'GENERIC.ARGUMENT_NOT_PROVIDED': 400,
      'GENERIC.ARGUMENT_OUT_OF_RANGE': 400,
      'UNAUTHORIZED': 401,
      'GENERIC.NOT_FOUND': 404,
      'PERSISTENCE.DATA_NOT_FOUND': 404,
      'GENERIC.CONFLICT': 409,
      'PERSISTENCE.DATA_CONFLICT': 409,
      'DOMAIN.BUSINESS': 422,
      'GENERIC.INTERNAL_SERVER_ERROR': 500,
      'PERSISTENCE.DATA_CREATION_FAILED': 500,
      'PERSISTENCE.QUERY_FAILED': 500,
      'PERSISTENCE.TRANSACTION_FAILED': 500,
      'PERSISTENCE.DATABASE_CONNECTION_FAILED': 503,
    };
    return mapping[code] || 500;
  }
}
```

### Correlation ID

Every exception automatically captures the correlation ID from `nestjs-cls`, enabling end-to-end request tracing across services. The ID is included in the serialized JSON response.

## Build

```bash
pnpm build   # Compile TypeScript
pnpm dev     # Watch mode
pnpm lint    # Lint
```

## Related Packages

- [`@arcaai/domains`](../domains/README.md) — Repositories throw persistence exceptions
- [`@arcaai/applications`](../applications/README.md) — Services throw application and domain exceptions
- [`@arcaai/logger`](../logger/README.md) — Logging exceptions for observability
