# @arcaai/exceptions

Standardized exception hierarchy for the HOPE backend. Every exception carries a stable machine-readable `code`, a request `correlationId` resolved from NestJS CLS, and a safe `toJSON()` serialization, so errors can cross process boundaries (HTTP responses, queue jobs, logs) without losing context.

Last updated: 2026-07-04

## Position in the stack

`@arcaai/exceptions` is a leaf dependency with no HOPE-internal dependencies (only `nestjs-cls`). It is consumed by every backend layer:

| Consumer                | Typical usage                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domains`      | Repositories throw `DataNotFoundException`, `DataCreationException`, `OptimisticConcurrencyException`; entities throw `BusinessException` |
| `packages/applications` | Services throw application exceptions (`ArgumentInvalidException`, `QuotaExceededException`, ...)                                         |
| `apps/api`              | Exception filters map codes to HTTP status codes                                                                                          |

## Directory structure

```
src/
├── common/                          # Base classes and shared codes
│   ├── base.exception.ts            # BaseException (correlationId, toJSON)
│   ├── base.domain-exception.ts     # BaseDomainException
│   ├── base.persistence-exception.ts# BasePersistenceException
│   └── exception.codes.ts           # Stable string codes (GENERIC.*, DOMAIN.*, PERSISTENCE.*)
├── backend/
│   ├── application/                 # HTTP-facing application errors
│   └── persistence/                 # Database/repository errors
├── domain/                          # Business-rule violations
└── index.ts                         # Barrel export (backend + common + domain)
```

## Exception catalog

| Class                            | Code                                     | Layer               |
| -------------------------------- | ---------------------------------------- | ------------------- |
| `ArgumentInvalidException`       | `GENERIC.ARGUMENT_INVALID`               | backend/application |
| `ArgumentNotProvidedException`   | `GENERIC.ARGUMENT_NOT_PROVIDED`          | backend/application |
| `ArgumentOutOfRangeException`    | `GENERIC.ARGUMENT_OUT_OF_RANGE`          | backend/application |
| `ConflictException`              | `GENERIC.CONFLICT`                       | backend/application |
| `InternalServerErrorException`   | `GENERIC.INTERNAL_SERVER_ERROR`          | backend/application |
| `NotFoundException`              | `GENERIC.NOT_FOUND`                      | backend/application |
| `UnauthorizedException`          | `UNAUTHORIZED`                           | backend/application |
| `DataConflictException`          | `PERSISTENCE.DATA_CONFLICT`              | backend/persistence |
| `DataCreationException`          | `PERSISTENCE.DATA_CREATION_FAILED`       | backend/persistence |
| `DataNotFoundException`          | `PERSISTENCE.DATA_NOT_FOUND`             | backend/persistence |
| `DatabaseConnectionException`    | `PERSISTENCE.DATABASE_CONNECTION_FAILED` | backend/persistence |
| `OptimisticConcurrencyException` | `PERSISTENCE.CONCURRENCY_CONFLICT`       | backend/persistence |
| `QueryFailedException`           | `PERSISTENCE.QUERY_FAILED`               | backend/persistence |
| `TransactionFailedException`     | `PERSISTENCE.TRANSACTION_FAILED`         | backend/persistence |
| `BusinessException`              | `DOMAIN.BUSINESS`                        | domain              |
| `QuotaExceededException`         | `DOMAIN.QUOTA_EXCEEDED`                  | domain              |

`QuotaExceededException` carries a typed `QuotaExceededMetadata` payload (`capability`, `limit`, `used`, `requested`, `tenantId`) so the API gateway can render a machine-readable 409/429 body.

## Key concepts

### BaseException

All exceptions extend `BaseException` (`src/common/base.exception.ts`), which:

- resolves `correlationId` from the active `nestjs-cls` context at construction time,
- exposes `toJSON(): SerializedException` returning `{ message, code, correlationId, stack?, cause?, metadata? }`,
- omits the stack trace when `NODE_ENV === 'production'`.

### Usage

Persistence errors thrown by the domain repository layer (real usage from `packages/domains/src/common/repository.ts`):

```typescript
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';

// Row missing
throw new DataNotFoundException(this._modelName, id);

// Compare-and-set version drift
throw new OptimisticConcurrencyException(this._modelName, id, {
  expectedVersion,
  currentVersion: current.version,
});
```

Application-level validation (as used in `packages/applications/src/services/department/department.service.ts`):

```typescript
import { ArgumentInvalidException } from '@arcaai/exceptions';

throw new ArgumentInvalidException('parentDepartmentId must reference an existing department');
```

Catching by type across layers:

```typescript
import { DataNotFoundException } from '@arcaai/exceptions';

try {
  return await fn();
} catch (err) {
  if (err instanceof DataNotFoundException) return null;
  throw err;
}
```

Note: HTTP-only errors such as NestJS `BadRequestException` / `ForbiddenException` are intentionally not duplicated here; controller-level code uses `@nestjs/common` exceptions directly.

## Commands

| Command | package.json script                      | From repo root                           |
| ------- | ---------------------------------------- | ---------------------------------------- |
| Build   | `tsc`                                    | `pnpm --filter @arcaai/exceptions build` |
| Watch   | `tsc -w`                                 | `pnpm --filter @arcaai/exceptions dev`   |
| Lint    | `eslint "src/**/*.ts*" --max-warnings 0` | `pnpm --filter @arcaai/exceptions lint`  |
| Clean   | `rimraf dist tsconfig.tsbuildinfo`       | `pnpm --filter @arcaai/exceptions clean` |

There is no per-package test script. The unit test in `src/backend/persistence/__tests__/optimisticConcurrency.exception.test.ts` runs as part of the root `pnpm test:unit` sweep.

## Dependencies

- `nestjs-cls` — request-scoped correlation ID resolution.
