# Quality Control

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Last Updated**: 2026-02-19

---

## Table of Contents

1. [Overview](#overview)
2. [Test Pyramid](#test-pyramid)
3. [Test Infrastructure](#test-infrastructure)
4. [Unit Tests](#unit-tests)
5. [Integration Tests](#integration-tests)
6. [End-to-End Tests](#end-to-end-tests)
7. [Contract Tests](#contract-tests)
8. [Agentic SDK v2 Testing](#agentic-sdk-v2-testing)
9. [Test Fixtures and Seed Data](#test-fixtures-and-seed-data)
10. [CI/CD Pipeline](#cicd-pipeline)
11. [Coverage Targets](#coverage-targets)
12. [Code Quality](#code-quality)
13. [Local Development Workflow](#local-development-workflow)
14. [Troubleshooting](#troubleshooting)

---

## Overview

The HOPE platform follows a **test pyramid** approach with three layers of automated testing, enforced through CI/CD pipelines. Key principles:

1. **Isolated test infrastructure** — Tests use separate ports from development
2. **Reproducible** — Same configuration for local development and CI
3. **Fast feedback** — Unit tests run without external dependencies
4. **No data pollution** — Tests never touch development databases

---

## Test Pyramid

```text
                    ┌─────────────────┐
                    │   E2E Tests     │  ← Full stack (slowest, highest confidence)
                    │   (Playwright)  │
                    └────────┬────────┘
                             │
               ┌─────────────┴─────────────┐
               │    Integration Tests      │  ← With real DB/services
               │    (Vitest + Prisma)      │
               └─────────────┬─────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │              Unit Tests                  │  ← Isolated, mocked (fastest)
        │         (Vitest / pytest)               │
        └──────────────────────────────────────────┘
```

---

## Test Infrastructure

### Port Allocation

| Service | Development Port | Test Port |
|---------|-----------------|-----------|
| PostgreSQL | 5432 | **5433** |
| Redis | 6379 | **6380** |
| Kafka | 9092 | **9093** |
| API Server | 8868 | **3000** |

### Configuration Files

| File | Purpose |
|------|---------|
| `.env.test` | Test environment variables (committed to repo) |
| `tests/docker-compose.test.yml` | Test infrastructure containers |
| `vitest.config.ts` | Unit test configuration |
| `vitest.integration.config.ts` | Integration test configuration |
| `playwright.config.ts` | E2E test configuration |

### Test Containers

Docker containers used for test infrastructure:

| Container | Image | Notes |
|-----------|-------|-------|
| PostgreSQL | `postgres:16-alpine` | tmpfs mount for speed |
| Redis | `redis:7-alpine` | tmpfs mount for speed |
| Kafka | `confluentinc/cp-kafka:7.6.0` | KRaft mode (no Zookeeper) |

All test containers use tmpfs mounts — data is stored in memory and is ephemeral.

---

## Unit Tests

**Purpose**: Test individual functions, classes, and components in isolation.

**Framework**: Vitest (TypeScript), pytest (Python)

**Characteristics**:
- No external dependencies (database, network, etc.)
- Uses mocks for all dependencies
- Kafka is automatically disabled (`KAFKA_ENABLED=false`)
- High code coverage target (90%)

**Location**: Co-located with source code in `__tests__` directories.

```text
packages/domains/src/utils/convertDateToUnixTimestamp.test.ts
packages/applications/src/authorization/__tests__/policy.engine.test.ts
apps/api/tests/unit/example.test.ts
```

**Commands**:

```bash
pnpm test:unit              # Run all unit tests
pnpm test:unit:watch        # Watch mode (re-runs on file changes)
pnpm test:unit:ui           # Vitest UI (visual test runner)
pnpm test:coverage          # Run with coverage report
```

---

## Integration Tests

**Purpose**: Test components working together with real infrastructure.

**Framework**: Vitest + Prisma (TypeScript)

**Characteristics**:
- Uses real database (test PostgreSQL on port 5433)
- Tests repository patterns, service layers, database operations
- Requires test containers running
- Coverage target: 80%

**Location**: `**/integration/**` directories.

```text
packages/applications/src/common/integration/service.integration.test.ts
tests/contracts/stt.contract.test.ts
```

**Commands**:

```bash
pnpm docker:test:up         # Start test containers first
pnpm test:integration       # Run integration tests
```

---

## End-to-End Tests

**Purpose**: Test complete user flows through the API.

**Framework**: Playwright

**Characteristics**:
- Full stack testing (API + database)
- Tests authentication, RBAC, CRUD operations
- Requires API server running on test environment
- Slowest but highest confidence

**Location**: `apps/api/tests/e2e/`

```text
apps/api/tests/e2e/auth.spec.ts
apps/api/tests/e2e/users.spec.ts
apps/api/tests/e2e/rbac.spec.ts
```

**Commands**:

```bash
pnpm dev:api:test           # Start API with test environment (Terminal 1)
pnpm test:e2e               # Run E2E tests (Terminal 2)
pnpm test:e2e:ui            # Playwright UI
pnpm test:e2e:debug         # Debug mode
```

---

## Contract Tests

**Purpose**: Validate API contracts between the API Gateway and Python services.

**Location**: `tests/contracts/`

```text
tests/contracts/stt.contract.test.ts
tests/contracts/tts.contract.test.ts
tests/contracts/smr.contract.test.ts
```

---

## Agentic SDK v2 Testing

The `@arcaai/vox` package has a dedicated test infrastructure with **298+ tests** covering all components.

### Test Architecture

```text
packages/agentic-sdk-v2/
├── src/
│   ├── __tests__/                    # Shared test utilities and mocks
│   ├── core/__tests__/               # Core component tests
│   │   ├── AgenticClient.test.ts     # HTTP client (GET/POST/PATCH/DELETE, headers, error handling)
│   │   ├── ModelRegistry.test.ts     # Model registration, selection, persistence
│   │   ├── PersonalizationManager.test.ts  # Storage modes, sync, change listeners
│   │   └── PluginManager.test.ts     # Plugin lifecycle, event callbacks
│   ├── core/logger/__tests__/        # Logger tests
│   │   ├── SDKLogger.test.ts         # Log levels, transports
│   │   ├── console.transport.test.ts # Console transport
│   │   ├── types.test.ts             # Type definitions
│   │   └── utils.test.ts             # Utility functions
│   ├── hooks/__tests__/              # React hook tests
│   │   ├── useArcaConfig.test.tsx    # Configuration hook
│   │   └── useArcaSession.test.tsx   # Session management hook
│   ├── providers/__tests__/          # Provider tests
│   │   └── AgenticProvider.test.tsx  # Initialization, context provision
│   └── store/__tests__/              # State management tests
│       └── agenticStore.test.ts      # Zustand store actions and selectors
└── vitest.config.mts                 # SDK-specific Vitest config
```

### Test Categories

| Category | Files | Tests | Description |
|----------|-------|-------|-------------|
| Core Components | 4 | ~80 | AgenticClient, ModelRegistry, PersonalizationManager, PluginManager |
| Logger | 4 | ~85 | SDKLogger, transports, types, utilities |
| React Hooks | 2 | ~20 | useArcaSession, useArcaConfig |
| Providers | 1 | ~12 | AgenticProvider initialization and context |
| State Management | 1 | ~34 | Zustand store actions and selectors |
| **Total** | **12** | **298+** | |

### SDK Test Configuration

The SDK uses a dedicated Vitest configuration:
- **Environment**: jsdom (browser-like)
- **Setup**: Global mocks for `@highlight-run/client`, `@opentelemetry/api`, `localStorage`, `fetch`
- **Coverage**: v8 provider with text, JSON, and HTML reporters
- **Dependencies**: `@testing-library/jest-dom`, `@testing-library/react`, `jsdom`

### SDK Test Utilities

Shared utilities in `src/__tests__/setup.ts`:
- Mock fetch response factories (`createMockResponse`, `createMockErrorResponse`)
- Test data factories (`createMockConsultation`, `createMockContextItem`, `createMockSummary`)
- Mock logger factory
- Async helpers (`waitFor`, `flushPromises`)

### Running SDK Tests

```bash
cd packages/agentic-sdk-v2
pnpm vitest run --config vitest.config.mts            # All tests
pnpm vitest --config vitest.config.mts                # Watch mode
pnpm vitest run --config vitest.config.mts --coverage  # With coverage
```

---

## Test Fixtures and Seed Data

### Seed Data System

The database seed system provides consistent test data:

| Execution Order | Seed File | Content |
|----------------|-----------|---------|
| 1 | `00-constants.ts` | Centralized UUIDs, identifiers |
| 2 | `01-policy.ts` | 12 RBAC policies |
| 3 | `02-apikey.ts` | API key configurations |
| 4 | `03-role.ts` | 7 system roles |
| 5 | `04-department.ts` | 15 medical departments |
| 6 | `05-tenant.ts` | 3 tenants |
| 7 | `06-stt.ts` | STT configurations |
| 8 | `07-prompt-template.ts` | 42 prompt templates |
| 9 | `08-dna-writing-style.ts` | Writing style configurations |
| 10 | `09-consultation.ts` | 2 sample consultations with context items |
| 11 | `91-user.ts` | 8 users across tenants |

### Test Fixtures

Located in `tests/fixtures/`:

| Fixture | Purpose |
|---------|---------|
| `users.fixture.ts` | User creation with role assignments |
| `roles.fixture.ts` | Role and RBAC test data |
| `tenants.fixture.ts` | Tenant creation for multi-tenancy tests |

### Seed Integrity Tests

**185 tests** validate seed data integrity covering:
- Correct record counts
- Referential integrity (foreign keys)
- Role-policy assignments
- User-role assignments
- Tenant isolation

---

## CI/CD Pipeline

### Pipeline Architecture

```text
PR Opened/Updated
       │
       ▼
┌─────────────────┐
│ Detect Changes  │  (paths-filter)
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────────┐
│ Lint  │ │Unit Tests │  (parallel)
└───┬───┘ └─────┬─────┘
    │           │
    └─────┬─────┘
          ▼
┌──────────────────┐
│Integration Tests │  (requires lint + unit)
└────────┬─────────┘
         │
         ▼ (only on PRs to main)
┌──────────────────┐
│    E2E Tests     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   CI Summary     │
└──────────────────┘
```

### Workflow Files

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| `ci.yml` | Orchestrator — coordinates all workflows | PR to main/develop |
| `test-unit.yml` | Unit tests for TypeScript and Python | PR, Push, Manual |
| `test-integration.yml` | Integration tests with real database | PR to main, Manual |
| `test-e2e.yml` | E2E API tests | PR to main, Manual |
| `lint-format.yml` | Linting and formatting checks | PR, Manual |

### Path Filtering

CI workflows skip unnecessary runs based on changed file paths:

- **TypeScript changes**: `apps/api/**/*.ts`, `packages/**/*.ts`
- **Python changes**: `apps/smr/**/*.py`, `apps/stt-v2/**/*.py`
- **Database changes**: `packages/database/**/*.prisma`
- **Test changes**: `tests/**`, `**/tests/**`
- **Documentation-only changes**: Skip all test workflows

### CI Service Containers

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5433:5432"]
  redis:
    image: redis:7-alpine
    ports: ["6380:6379"]
  kafka:
    image: confluentinc/cp-kafka:7.6.0
    ports: ["9093:9092"]
```

### Shared GitHub Actions

| Action | Purpose |
|--------|---------|
| `setup-test-env` | Configure test environment variables |
| `setup-node-pnpm` | Setup Node.js + pnpm with caching |
| `setup-python-uv` | Setup Python + uv with caching |
| `build-packages` | Build packages with Prisma generation |

### Manual Dispatch Options

All workflows support manual triggering:

| Option | Available In | Default |
|--------|-------------|---------|
| `skip-typescript` | Unit, Integration | false |
| `skip-python` | Unit, Integration | false |
| `coverage-threshold` | Unit | 90% |
| `python-services` | Unit, Integration | smr,stt,tts,nlp |
| `reset-database` | Integration | false |
| `test-filter` | E2E | — |
| `retries` | E2E | 2 |
| `workers` | E2E | 1 |

---

## Coverage Targets

| Test Type | Target | Enforcement |
|-----------|--------|-------------|
| Unit Tests (TypeScript) | 90% | CI warning |
| Unit Tests (Python) | 90% | CI warning |
| Integration Tests | 80% | CI warning |
| SDK Unit Tests | 90% | CI warning |
| E2E Tests | N/A | Feature coverage |

Coverage reports are generated by Vitest (v8 provider) and uploaded as CI artifacts.

### SDK Coverage by Component

| Component | Target |
|-----------|--------|
| Core Components | 90% |
| Logger | 90% |
| React Hooks | 80% |
| State Store | 90% |

---

## Code Quality

### Static Analysis

| Tool | Purpose | Configuration |
|------|---------|---------------|
| ESLint | Code quality and consistency | Shared config in `packages/config-eslint` |
| Prettier | Code formatting | Shared config in `packages/config-prettier` |
| TypeScript | Static type analysis | Strict mode, shared `tsconfig` base |
| Husky | Pre-commit hooks | Quality gates before commit |

### Commit Standards

- Conventional commits for clear change tracking
- Pre-commit hooks enforce linting and formatting
- All PRs require passing CI checks

---

## Local Development Workflow

### Quick Start

```bash
# 1. Start test containers
pnpm docker:test:up

# 2. Setup database
pnpm test:db:push && pnpm test:db:seed

# 3. Run tests
pnpm test:unit              # Unit tests (no containers needed)
pnpm test:integration       # Integration tests (requires containers)
pnpm test:e2e               # E2E tests (requires containers + API)

# 4. Stop containers
pnpm docker:test:down
```

### One-Command Setup

```bash
pnpm test:setup             # docker:test:up + db:push + db:seed
```

### Complete Script Reference

```bash
# Unit Tests
pnpm test:unit              # Run unit tests
pnpm test:unit:watch        # Watch mode
pnpm test:unit:ui           # Vitest UI

# Integration Tests
pnpm test:integration       # Run integration tests

# E2E Tests
pnpm test:e2e               # Run E2E tests
pnpm test:e2e:ui            # Playwright UI
pnpm test:e2e:debug         # Debug mode

# Combined
pnpm test:all               # All tests
pnpm test:ci                # Same as test:all (for CI)
pnpm test:coverage          # With coverage report

# Infrastructure
pnpm docker:test:up         # Start test containers
pnpm docker:test:down       # Stop and remove containers
pnpm docker:test:logs       # View container logs
pnpm docker:test:status     # Check container status

# Database
pnpm test:db:push           # Push schema to test DB
pnpm test:db:seed           # Seed test data
pnpm test:db:reset          # Push + seed

# API for E2E
pnpm dev:api:test           # Start API with test environment
```

---

## Troubleshooting

### `DATABASE_URL not set`

Ensure `.env.test` exists. Tests are run via `dotenv-cli`:

```bash
ls -la .env.test
dotenv -e .env.test -- vitest run
```

### Port already in use (5433, 6380, 9093)

```bash
pnpm docker:test:status     # Check running containers
pnpm docker:test:down       # Stop existing containers
lsof -i :5433               # Find process on port
```

### Kafka connection errors

```bash
docker logs hope-kafka-test
pnpm docker:test:down && pnpm docker:test:up
```

Unit tests disable Kafka automatically (`KAFKA_ENABLED=false`).

### E2E: API not ready

```bash
curl http://localhost:8868/api/v1/api/health
pnpm dev:api:test           # Start API on test port
```

### Schema mismatch

```bash
pnpm test:db:reset          # Push + seed
```

### Tests pass locally, fail in CI

1. Check environment consistency (CI uses `setup-test-env` action, local uses `.env.test`)
2. Check service availability (CI starts fresh each run)
3. Check timing issues (CI may need longer startup)

---

## Related Documentation

- [Project Brief & Requirements](./01_PROJECT_BRIEF_AND_REQUIREMENTS.md) — Business context and feature scope
- [Technical Architecture](./02_TECHNICAL_ARCHITECTURE.md) — System architecture and tech stack
- [Access Control](./04_ACCESS_CONTROL.md) — Authentication, RBAC, security testing
