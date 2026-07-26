# TEST-001: Implementation Planning

## Phase 1: Foundation - Detailed Task Breakdown

### 1.1 Vitest Configuration

#### Task 1.1.1: Create Root Vitest Config
**File:** `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
});
```

#### Task 1.1.2: Create Vitest Workspace Config
**File:** `vitest.workspace.ts`

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // Packages with unit tests
  'packages/domains',
  'packages/applications',
  'packages/logger',
  'packages/database',

  // API app tests
  {
    extends: './vitest.config.ts',
    test: {
      name: 'api-unit',
      root: './apps/api',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'api-integration',
      root: './apps/api',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['./tests/setup/integration.setup.ts'],
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
  },
]);
```

#### Task 1.1.3: Create Vitest Setup File
**File:** `tests/setup/vitest.setup.ts`

```typescript
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Global test setup
beforeAll(async () => {
  // Any global setup needed
  console.log('Starting test suite...');
});

afterAll(async () => {
  // Any global cleanup needed
  console.log('Test suite completed.');
});

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

---

### 1.2 Playwright Setup

#### Task 1.2.1: Install Playwright Dependencies
```bash
pnpm add -D @playwright/test
npx playwright install
```

#### Task 1.2.2: Create Playwright Config
**File:** `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/api/tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ...(process.env.CI ? [['github']] : []),
  ],
  use: {
    baseURL: process.env.API_URL || 'http://localhost:8868/api/v1',
    extraHTTPHeaders: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'api-tests',
      testMatch: '**/*.spec.ts',
    },
  ],
  globalSetup: './tests/setup/playwright.global-setup.ts',
  globalTeardown: './tests/setup/playwright.global-teardown.ts',
});
```

#### Task 1.2.3: Create Playwright Global Setup
**File:** `tests/setup/playwright.global-setup.ts`

```typescript
import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';

async function globalSetup(config: FullConfig) {
  console.log('Starting test infrastructure...');

  // Start Docker containers if not running
  try {
    execSync('docker compose -f tests/docker-compose.test.yml up -d --wait', {
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('Failed to start Docker containers:', error);
    throw error;
  }

  // Wait for API to be ready
  const baseURL = config.projects[0].use?.baseURL || 'http://localhost:8868/api/v1';
  await waitForApi(baseURL);

  console.log('Test infrastructure ready.');
}

async function waitForApi(baseURL: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // API not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('API did not become ready in time');
}

export default globalSetup;
```

#### Task 1.2.4: Create Playwright Global Teardown
**File:** `tests/setup/playwright.global-teardown.ts`

```typescript
import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';

async function globalTeardown(config: FullConfig) {
  console.log('Cleaning up test infrastructure...');

  // Only stop containers if not in CI (CI handles cleanup)
  if (!process.env.CI) {
    try {
      execSync('docker compose -f tests/docker-compose.test.yml down -v', {
        stdio: 'inherit',
      });
    } catch (error) {
      console.warn('Failed to stop Docker containers:', error);
    }
  }

  console.log('Cleanup complete.');
}

export default globalTeardown;
```

---

### 1.3 Docker Test Infrastructure

#### Task 1.3.1: Create Test Docker Compose
**File:** `tests/docker-compose.test.yml`

```yaml
version: '3.8'

name: hope-test

services:
  postgres-test:
    image: postgres:16-alpine
    container_name: hope-postgres-test
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: hope_test
    ports:
      - '5433:5432'
    volumes:
      - postgres-test-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U test -d hope_test']
      interval: 5s
      timeout: 5s
      retries: 5
    tmpfs:
      - /var/lib/postgresql/data

  redis-test:
    image: redis:8-alpine
    container_name: hope-redis-test
    ports:
      - '6380:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres-test-data:
```

#### Task 1.3.2: Create Test Environment File
**File:** `.env.test`

```env
# Database
DATABASE_URL="postgresql://test:test@localhost:5433/hope_test?schema=public"

# Redis
REDIS_URL="redis://localhost:6380"

# JWT
JWT_SECRET="test-jwt-secret-for-testing-only"
JWT_EXPIRES_IN="1h"

# API
API_URL="http://localhost:8868/api/v1"
NODE_ENV="test"
```

---

### 1.4 Shared Test Utilities

#### Task 1.4.1: Create Auth Helper
**File:** `tests/helpers/auth.helper.ts`

```typescript
import { sign, verify } from 'jsonwebtoken';

export interface TestUser {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
}

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';

export function generateTestToken(user: TestUser, expiresIn = '1h'): string {
  return sign(
    {
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles,
      permissions: user.permissions || [],
    },
    JWT_SECRET,
    { expiresIn }
  );
}

export function createTestUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: `test-user-${Date.now()}`,
    email: `test-${Date.now()}@example.com`,
    tenantId: 'test-tenant-id',
    roles: ['user'],
    permissions: [],
    ...overrides,
  };
}

export function createAdminUser(overrides: Partial<TestUser> = {}): TestUser {
  return createTestUser({
    roles: ['admin'],
    permissions: ['*'],
    ...overrides,
  });
}

export function createSuperAdminUser(overrides: Partial<TestUser> = {}): TestUser {
  return createTestUser({
    roles: ['super_admin'],
    permissions: ['*'],
    ...overrides,
  });
}

export function verifyToken(token: string): TestUser | null {
  try {
    const decoded = verify(token, JWT_SECRET) as any;
    return {
      id: decoded.sub,
      email: decoded.email,
      tenantId: decoded.tenantId,
      roles: decoded.roles,
      permissions: decoded.permissions,
    };
  } catch {
    return null;
  }
}
```

#### Task 1.4.2: Create Database Helper
**File:** `tests/helpers/db.helper.ts`

```typescript
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

let prisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }
  return prisma;
}

export async function resetDatabase(): Promise<void> {
  const client = getPrismaClient();

  // Get all table names
  const tables = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  // Disable foreign key checks and truncate all tables
  await client.$executeRaw`SET session_replication_role = 'replica'`;

  for (const { tablename } of tables) {
    if (tablename !== '_prisma_migrations') {
      await client.$executeRawUnsafe(`TRUNCATE TABLE "${tablename}" CASCADE`);
    }
  }

  await client.$executeRaw`SET session_replication_role = 'origin'`;
}

export async function seedTestData(): Promise<void> {
  // Run seed script for test data
  execSync('pnpm seed:test', { stdio: 'inherit' });
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function runMigrations(): Promise<void> {
  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
    },
  });
}
```

#### Task 1.4.3: Create API Helper
**File:** `tests/helpers/api.helper.ts`

```typescript
import { APIRequestContext, request } from '@playwright/test';
import { generateTestToken, TestUser } from './auth.helper';

export interface ApiClient {
  request: APIRequestContext;
  token: string;
  user: TestUser;
}

export async function createApiClient(user: TestUser): Promise<ApiClient> {
  const token = generateTestToken(user);
  const apiRequest = await request.newContext({
    baseURL: process.env.API_URL || 'http://localhost:8868/api/v1',
    extraHTTPHeaders: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });

  return {
    request: apiRequest,
    token,
    user,
  };
}

export async function createUnauthenticatedClient(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: process.env.API_URL || 'http://localhost:8868/api/v1',
    extraHTTPHeaders: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

export function expectSuccessResponse(status: number): void {
  if (status < 200 || status >= 300) {
    throw new Error(`Expected success status, got ${status}`);
  }
}

export function expectErrorResponse(status: number, expectedStatus: number): void {
  if (status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${status}`);
  }
}
```

#### Task 1.4.4: Create User Fixture
**File:** `tests/fixtures/users.fixture.ts`

```typescript
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuidv7';
import { hash } from 'bcryptjs';

export interface CreateUserOptions {
  email?: string;
  name?: string;
  password?: string;
  tenantId?: string;
  isActive?: boolean;
}

export async function createUserFixture(
  prisma: PrismaClient,
  options: CreateUserOptions = {}
): Promise<{ id: string; email: string; password: string }> {
  const id = uuidv7();
  const email = options.email || `test-${id}@example.com`;
  const password = options.password || 'TestPassword123!';
  const hashedPassword = await hash(password, 10);

  await prisma.user.create({
    data: {
      id,
      email,
      name: options.name || 'Test User',
      password: hashedPassword,
      tenantId: options.tenantId || 'default-tenant',
      isActive: options.isActive ?? true,
    },
  });

  return { id, email, password };
}

export async function createUsersFixture(
  prisma: PrismaClient,
  count: number,
  options: CreateUserOptions = {}
): Promise<Array<{ id: string; email: string; password: string }>> {
  const users = [];
  for (let i = 0; i < count; i++) {
    const user = await createUserFixture(prisma, {
      ...options,
      email: options.email ? `${i}-${options.email}` : undefined,
    });
    users.push(user);
  }
  return users;
}

export async function deleteUserFixture(
  prisma: PrismaClient,
  userId: string
): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}
```

#### Task 1.4.5: Create Roles Fixture
**File:** `tests/fixtures/roles.fixture.ts`

```typescript
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuidv7';

export interface CreateRoleOptions {
  name?: string;
  description?: string;
  permissions?: string[];
  tenantId?: string;
}

export async function createRoleFixture(
  prisma: PrismaClient,
  options: CreateRoleOptions = {}
): Promise<{ id: string; name: string }> {
  const id = uuidv7();
  const name = options.name || `test-role-${id}`;

  await prisma.role.create({
    data: {
      id,
      name,
      description: options.description || 'Test role',
      tenantId: options.tenantId || 'default-tenant',
    },
  });

  return { id, name };
}

export async function assignRoleToUser(
  prisma: PrismaClient,
  userId: string,
  roleId: string
): Promise<void> {
  await prisma.userRole.create({
    data: {
      id: uuidv7(),
      userId,
      roleId,
    },
  });
}

export async function createRoleWithPermissions(
  prisma: PrismaClient,
  roleName: string,
  permissions: string[],
  tenantId?: string
): Promise<{ id: string; name: string }> {
  const role = await createRoleFixture(prisma, {
    name: roleName,
    tenantId,
  });

  // Assign permissions to role
  for (const permission of permissions) {
    await prisma.rolePermission.create({
      data: {
        id: uuidv7(),
        roleId: role.id,
        permissionId: permission,
      },
    });
  }

  return role;
}
```

---

### 1.5 GitHub Actions Workflows

#### Task 1.5.1: Unit Tests Workflow
**File:** `.github/workflows/test-unit.yml`

```yaml
name: Unit Tests

on:
  pull_request:
    branches: [main, develop, 'feat/*']
  push:
    branches: [main, develop]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Generate Prisma client
        run: pnpm db:generate

      - name: Build packages
        run: pnpm build:packages

      - name: Run unit tests
        run: pnpm test:unit --coverage

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          flags: unit-tests
          fail_ci_if_error: false

      - name: Upload coverage artifacts
        uses: actions/upload-artifact@v4
        with:
          name: coverage-unit
          path: coverage/
          retention-days: 7
```

#### Task 1.5.2: Integration Tests Workflow
**File:** `.github/workflows/test-integration.yml`

```yaml
name: Integration Tests

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: hope_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:8-alpine
        ports:
          - 6380:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://test:test@localhost:5433/hope_test?schema=public
      REDIS_URL: redis://localhost:6380
      JWT_SECRET: test-jwt-secret
      NODE_ENV: test

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Generate Prisma client
        run: pnpm db:generate

      - name: Run database migrations
        run: pnpm prisma migrate deploy

      - name: Build packages
        run: pnpm build:packages && pnpm build:modules

      - name: Run integration tests
        run: pnpm test:integration --coverage

      - name: Upload coverage artifacts
        uses: actions/upload-artifact@v4
        with:
          name: coverage-integration
          path: coverage/
          retention-days: 7
```

#### Task 1.5.3: E2E Tests Workflow
**File:** `.github/workflows/test-e2e.yml`

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e-tests:
    name: E2E Tests
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: hope_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:8-alpine
        ports:
          - 6380:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://test:test@localhost:5433/hope_test?schema=public
      REDIS_URL: redis://localhost:6380
      JWT_SECRET: test-jwt-secret
      NODE_ENV: test
      API_URL: http://localhost:8868/api/v1

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Generate Prisma client
        run: pnpm db:generate

      - name: Run database migrations
        run: pnpm prisma migrate deploy

      - name: Seed test data
        run: pnpm seed

      - name: Build application
        run: pnpm build:packages && pnpm build:modules && pnpm build:api

      - name: Start API server
        run: pnpm start:api &
        env:
          PORT: 3000

      - name: Wait for API to be ready
        run: |
          for i in {1..30}; do
            curl -s http://localhost:8868/api/v1/health && break
            sleep 2
          done

      - name: Run E2E tests
        run: pnpm test:e2e

      - name: Upload Playwright report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: test-results/
          retention-days: 7

      - name: Upload Playwright traces
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-traces
          path: test-results/
          retention-days: 7
```

---

### 1.6 NPM Scripts Update

#### Task 1.6.1: Update Root package.json
Add the following scripts to the root `package.json`:

```json
{
  "scripts": {
    "test": "turbo run test",
    "test:unit": "vitest run --project '!*integration*' --project '!*e2e*'",
    "test:unit:watch": "vitest --project '!*integration*' --project '!*e2e*'",
    "test:unit:ui": "vitest --ui --project '!*integration*' --project '!*e2e*'",
    "test:integration": "vitest run --project '*integration*'",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:debug": "playwright test --debug",
    "test:coverage": "vitest run --coverage",
    "test:ci": "pnpm test:unit && pnpm test:integration && pnpm test:e2e",
    "docker:test:up": "docker compose -f tests/docker-compose.test.yml up -d --wait",
    "docker:test:down": "docker compose -f tests/docker-compose.test.yml down -v",
    "docker:test:logs": "docker compose -f tests/docker-compose.test.yml logs -f"
  }
}
```

---

## Dependencies to Install

```bash
# Root level dev dependencies
pnpm add -D vitest @vitest/coverage-v8 @vitest/ui @playwright/test

# For test utilities
pnpm add -D dotenv bcryptjs

# Types
pnpm add -D @types/bcryptjs
```

---

## Checklist for Phase 1 Completion

- [ ] Vitest configuration files created
- [ ] Playwright configuration created
- [ ] Docker Compose test file created
- [ ] Test environment file created
- [ ] Auth helper implemented
- [ ] Database helper implemented
- [ ] API helper implemented
- [ ] User fixture implemented
- [ ] Roles fixture implemented
- [ ] GitHub Actions workflows created
- [ ] NPM scripts updated
- [ ] Dependencies installed
- [ ] `pnpm test:unit` runs successfully
- [ ] `pnpm test:integration` runs successfully (with Docker)
- [ ] `pnpm test:e2e` runs successfully (with Docker + API)
- [ ] GitHub Actions passes on PR
