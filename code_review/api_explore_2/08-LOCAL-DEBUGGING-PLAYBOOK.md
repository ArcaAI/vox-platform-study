# Local Debugging & Test Reproduction Playbook

This document provides developer recipes for running the HOPE API Gateway ([`apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)) locally, attaching step-through debuggers, running targeted test suites, and regenerating contract artifacts.

---

## 1. Running the Gateway Locally

From the repository root ([`/Users/apple/repos/VOX/project-hope`](file:///Users/apple/repos/VOX/project-hope)):

```bash
# 1. Start local supporting infrastructure (PostgreSQL, Redis, MinIO)
pnpm infra:up

# 2. Run the API Gateway in development mode with hot-reload
pnpm api:dev

# Or run with simultaneous watch on @arcaai/applications packages:
pnpm api:dev:watch
```

The gateway boots on **port 8868**.

### Interactive Swagger UI:
In non-production environments (`NODE_ENV !== 'production'`), interactive Swagger documentation is mounted at:
```text
http://localhost:8868/api/v1/docs
```

---

## 2. Attaching a Debugger (VS Code & WebStorm)

To attach a step-through debugger to the NestJS gateway process:

### Launch Command:
```bash
pnpm --filter @arcaai/api exec nest start --debug 0.0.0.0:9229 --watch
```

### VS Code `launch.json` Configuration:
Add this configuration to `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to API Gateway (Port 9229)",
      "address": "localhost",
      "port": 9229,
      "restart": true,
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/apps/api/dist/**/*.js"]
    }
  ]
}
```
Set breakpoints directly in any controller (e.g. [`consultation.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts)) or guard.

---

## 3. Targeted Test Execution

Rather than running the massive full test suite, run targeted tests when debugging specific features:

### A. Run Unit Tests for a Single Controller:
```bash
# Test Consultation Controller
pnpm --filter @arcaai/api vitest run src/modules/consultation/__tests__/consultation.controller.test.ts

# Test Rate Limit Admin Controller
pnpm --filter @arcaai/api vitest run src/modules/admin-rate-limit/__tests__/rate-limit-admin.controller.test.ts
```

### B. Run In-Memory Integration Tests:
The integration test suite uses [`test-app-module.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/tests/helpers/test-app-module.ts) to boot the complete NestJS application with in-memory mocks (no external services needed):
```bash
# Test full route walk and metadata validation
pnpm --filter @arcaai/api vitest run tests/integration/full-route-walk.spec.ts

# Test authorization and permission decorator coverage
pnpm --filter @arcaai/api vitest run tests/integration/auth-coverage.spec.ts
```

### C. Run Specific Playwright E2E Tests:
Playwright e2e tests run against a live gateway running on port **8968** (`.env.test`):
```bash
# 1. Start the test gateway instance
pnpm test:up:api

# 2. Run the Route Authorization Matrix test
pnpm --filter @arcaai/api test:e2e tests/e2e/task-776-route-authz-matrix.spec.ts

# 3. Run Optimistic Concurrency Control test
pnpm --filter @arcaai/api test:e2e tests/e2e/optimistic-locking.spec.ts
```

---

## 4. Contract Drift & Artifact Regeneration

Whenever you change any route, HTTP verb, DTO, guard, or Swagger decorator, you **must regenerate the five contract artifacts together**:

```bash
pnpm api:build && \
pnpm api:route-manifest && \
pnpm api:openapi && \
pnpm api:portal && \
pnpm --filter @arcaai/vox-node gen:admin
```

### Checking for Contract Drift (CI Gates):
Run these check commands to ensure your changes didn't drift from the committed contract files:
```bash
# Verify route-manifest.json and openapi.json are in sync with code
pnpm api:openapi:check
pnpm api:portal:check
pnpm --filter @arcaai/vox-node gen:admin:check
```
