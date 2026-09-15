# @arcaai/exceptions — the standardized exception hierarchy

Standardized exception hierarchy for the HOPE backend. Every exception carries a stable
machine-readable `code`, a request `correlationId` resolved from NestJS CLS, and a safe `toJSON()`
serialization, so errors can cross process boundaries (HTTP responses, queue jobs, logs) without
losing context. A leaf dependency with no HOPE-internal dependencies (only `nestjs-cls`), consumed
by every backend layer: `packages/domains` (`DataNotFoundException`, `OptimisticConcurrencyException`,
...), `packages/applications` (`ArgumentInvalidException`, `QuotaExceededException`, ...), and
`apps/api` (exception filters map codes to HTTP status codes).

## Layout

| Path | What it holds |
|---|---|
| `src/common/base.exception.ts` | `BaseException` (correlationId, `toJSON`) |
| `src/common/base.domain-exception.ts` | `BaseDomainException` |
| `src/common/base.persistence-exception.ts` | `BasePersistenceException` |
| `src/common/exception.codes.ts` | Stable string codes (`GENERIC.*`, `DOMAIN.*`, `PERSISTENCE.*`) |
| `src/backend/application/` | HTTP-facing application errors |
| `src/backend/persistence/` | Database/repository errors |
| `src/domain/` | Business-rule violations |
| `src/index.ts` | Barrel export (backend + common + domain) |

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsc` | `pnpm --filter @arcaai/exceptions build` |
| Watch | `tsc -w` | `pnpm --filter @arcaai/exceptions dev` |
| Test | `vitest run --passWithNoTests` | `pnpm --filter @arcaai/exceptions test` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/exceptions typecheck` |
| Lint | `eslint "src/**/*.ts*" --max-warnings 0` | `pnpm --filter @arcaai/exceptions lint` |
| Clean | `rimraf dist tsconfig.tsbuildinfo` | `pnpm --filter @arcaai/exceptions clean` |

Unit tests (e.g. `src/backend/persistence/__tests__/optimisticConcurrency.exception.test.ts`) also
run as part of the root `pnpm test:unit` sweep.

## How it works

### Exception catalog

| Class | Code | Layer |
|---|---|---|
| `ArgumentInvalidException` | `GENERIC.ARGUMENT_INVALID` | backend/application |
| `ArgumentNotProvidedException` | `GENERIC.ARGUMENT_NOT_PROVIDED` | backend/application |
| `ArgumentOutOfRangeException` | `GENERIC.ARGUMENT_OUT_OF_RANGE` | backend/application |
| `ConflictException` | `GENERIC.CONFLICT` | backend/application |
| `InternalServerErrorException` | `GENERIC.INTERNAL_SERVER_ERROR` | backend/application |
| `NotFoundException` | `GENERIC.NOT_FOUND` | backend/application |
| `UnauthorizedException` | `UNAUTHORIZED` | backend/application |
| `DataConflictException` | `PERSISTENCE.DATA_CONFLICT` | backend/persistence |
| `DataCreationException` | `PERSISTENCE.DATA_CREATION_FAILED` | backend/persistence |
| `DataNotFoundException` | `PERSISTENCE.DATA_NOT_FOUND` | backend/persistence |
| `DatabaseConnectionException` | `PERSISTENCE.DATABASE_CONNECTION_FAILED` | backend/persistence |
| `OptimisticConcurrencyException` | `PERSISTENCE.CONCURRENCY_CONFLICT` | backend/persistence |
| `QueryFailedException` | `PERSISTENCE.QUERY_FAILED` | backend/persistence |
| `TransactionFailedException` | `PERSISTENCE.TRANSACTION_FAILED` | backend/persistence |
| `BusinessException` | `DOMAIN.BUSINESS` | domain |
| `QuotaExceededException` | `DOMAIN.QUOTA_EXCEEDED` | domain |
| `SpendLimitExceededException` | `DOMAIN.SPEND_LIMIT_EXCEEDED` | domain |
| `ProviderCredentialVetoedException` | `DOMAIN.PROVIDER_CREDENTIAL_VETOED` | domain |
| `ConsentDeniedException` | `DOMAIN.CONSENT_DENIED` | domain |
| `ConsentUnavailableException` | `DOMAIN.CONSENT_UNAVAILABLE` | domain |

The status-code mapping is a fact about the GATEWAY, not this package, but is worth knowing when
picking which to throw: `QuotaExceededException` maps to 409 (create) / 429 (meter);
`SpendLimitExceededException` maps to 402; `ProviderCredentialVetoedException` maps to 409 (the
tenant's own connection row disabled that provider — a tenant admin can clear it, distinguishing it
from the 403 a missing entitlement produces); `ConsentDeniedException` maps to 403 (a real,
un-alarming compliance denial); `ConsentUnavailableException` maps to 503 (the grant-store lookup
itself failed and denied fail-closed — an infrastructure incident, not a compliance event, and
therefore alerted differently from `ConsentDeniedException`).

`QuotaExceededException` carries a typed `QuotaExceededMetadata` payload (`capability`, `limit`,
`used`, `requested`, `tenantId`) so the API gateway can render a machine-readable 409/429 body.

### BaseException

All exceptions extend `BaseException` (`src/common/base.exception.ts`), which:

- resolves `correlationId` from the active `nestjs-cls` context at construction time,
- exposes `toJSON(): SerializedException` returning `{ message, code, correlationId, stack?, cause?, metadata? }`,
- omits the stack trace when `NODE_ENV === 'production'`.

### Usage

Persistence errors thrown by the domain repository layer (real usage from
`packages/domains/src/common/repository.ts`):

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

Application-level validation:

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

HTTP-only errors such as NestJS `BadRequestException` / `ForbiddenException` are intentionally not
duplicated here; controller-level code uses `@nestjs/common` exceptions directly.

## Related

- [`03-domain-layer.md`](../../.claude/rules/03-domain-layer.md) — where `DataNotFoundException`/`OptimisticConcurrencyException` are thrown
- [`04-application-services.md`](../../.claude/rules/04-application-services.md) — where application-layer exceptions are thrown
