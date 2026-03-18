# Test Infrastructure Review

**Reviewed**: 2026-01-27
**Status**: Issues Fixed

---

## Summary

The HOPE monorepo has a well-structured test infrastructure with proper isolation between development and test environments. This review identified and fixed several inconsistencies.

---

## Infrastructure Overview

### Environment Files

| File | Purpose | Ports |
|------|---------|-------|
| `.env.test` | Test environment | PostgreSQL:5433, Redis:6380, Kafka:9093, MinIO:9002 |
| `.env.dev` | Development | PostgreSQL:5432, Redis:6379, Kafka:9092, MinIO:9000 |

### Test Services (docker-compose.test.yml)

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| postgres-test | postgres:16-alpine | 5433 | Test database |
| redis-test | redis:7-alpine | 6380 | Test cache |
| kafka-test | apache/kafka:4.0.0 | 9093 | Test message broker |
| minio-test | minio/minio:latest | 9002 | Test object storage |

### Test Types

| Type | Command | Config | Requires |
|------|---------|--------|----------|
| Unit | `pnpm test:unit` | vitest.config.ts | None |
| Integration | `pnpm test:integration` | vitest.integration.config.ts | Database, Redis |
| E2E | `pnpm test:e2e` | playwright.config.ts | Full stack |

---

## Issues Fixed

### 1. Kafka Configuration Inconsistency

**Problem**: `setup-test-env` action defaulted to `kafka-enabled: 'true'`, but `.env.test` has `KAFKA_ENABLED=false`.

**Fix**: Changed default in `.github/actions/setup-test-env/action.yml` to `'false'`.

### 2. MinIO Missing from docker-compose.test.yml

**Problem**: `.env.test` references MinIO on port 9002, but container wasn't defined.

**Fix**: Added `minio-test` service to `tests/docker-compose.test.yml`.

### 3. Unit Tests Not Excluding Integration Tests

**Problem**: `vitest.config.ts` didn't exclude `**/integration/**` directories.

**Fix**: Added exclusion patterns to `vitest.config.ts`.

### 4. Missing Setup File in vitest.config.ts

**Problem**: Unit tests weren't using the setup file.

**Fix**: Added `setupFiles: ['./tests/setup/vitest.setup.ts']`.

### 5. API Health Check URL Inconsistency

**Problem**: `waitForApi` used `/health` but API uses `/api/health`.

**Fix**: Updated `tests/helpers/db.helper.ts` to use `/api/health`.

### 6. Missing KafkaJS Warning Suppression

**Problem**: KafkaJS v2.0.0 partitioner warning cluttered test output.

**Fix**: Added `KAFKAJS_NO_PARTITIONER_WARNING=1` to `.env.test` and `setup-test-env` action.

---

## Workflow Compatibility

### Local Development

```bash
# Start test infrastructure
pnpm docker:test:up

# Setup database
pnpm test:db:push && pnpm test:db:seed

# Run tests
pnpm test:unit        # No external deps (KAFKA_ENABLED=false)
pnpm test:integration # Requires DB, Redis
pnpm test:e2e         # Requires full stack

# Stop infrastructure
pnpm docker:test:down
```

### CI/CD (GitHub Actions)

- Uses GitHub Actions service containers (not docker-compose)
- Environment set via `setup-test-env` action
- Same configuration as local `.env.test`
- Kafka disabled by default (can be enabled per-workflow)

### Environment Loading

| Environment | How | Priority |
|-------------|-----|----------|
| Local tests | `dotenv-cli -e .env.test` | .env.test > host |
| CI tests | `setup-test-env` action | Host only (CI=true) |
| Production | Host environment | Host only |

---

## Best Practices Implemented

### 1. Port Isolation
All test services use different ports from development to allow concurrent usage.

### 2. Ephemeral Storage
Test containers use `tmpfs` for fast, ephemeral data storage.

### 3. Health Checks
All services have proper health checks with appropriate intervals.

### 4. Single Fork for Integration Tests
Integration tests run in a single fork to avoid database conflicts.

### 5. Optional Service Dependencies
Services like Kafka are disabled by default, enabling faster unit tests.

---

## Recommendations for Future

### 1. Add MinIO to GitHub Actions Services
If MinIO is needed for integration/E2E tests, add it as a service in workflows.

### 2. Create Kafka Topics Script
For tests that need Kafka, create a script to pre-create required topics:
```bash
scripts/create-kafka-topics.sh
```

### 3. Consider Test Database Transactions
For integration tests, wrap each test in a transaction that rolls back:
```typescript
beforeEach(async () => {
  await prisma.$executeRaw`BEGIN`;
});
afterEach(async () => {
  await prisma.$executeRaw`ROLLBACK`;
});
```

### 4. Add Test Timeout Configuration
Consider environment variable for test timeouts:
```
TEST_TIMEOUT=30000
```

---

## Files Modified

- `.github/actions/setup-test-env/action.yml` - Fixed Kafka default
- `tests/docker-compose.test.yml` - Added MinIO service
- `vitest.config.ts` - Added exclusions and setup file
- `tests/helpers/db.helper.ts` - Fixed health check URL
- `.env.test` - Added KAFKAJS_NO_PARTITIONER_WARNING
