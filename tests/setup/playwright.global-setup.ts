/**
 * Playwright Global Setup
 *
 * This file runs once before all Playwright E2E tests.
 *
 * LOCAL WORKFLOW:
 *   1. Start test containers: pnpm docker:test:up
 *   2. Setup database: pnpm test:db:push && pnpm test:db:seed
 *   3. Start API: pnpm dev:api:test (in separate terminal)
 *   4. (Optional) Start Python services for full-stack E2E:
 *      - pnpm dev:stt-v2:test
 *      - pnpm dev:smr-v2:test
 *      - pnpm dev:nlp:test
 *   5. Run E2E tests: pnpm test:e2e
 *
 * CI WORKFLOW:
 *   - GitHub Actions sets up services (Postgres, Redis)
 *   - Environment configured via setup-test-env action
 *   - API started as part of workflow
 *
 * This setup:
 *   - Verifies test infrastructure is ready
 *   - Does NOT start Docker containers (do this manually)
 *   - Does NOT start API server (do this manually or via CI)
 *   - Waits for API to be available
 *   - Optionally waits for Python services (STT-v2, SMR-v2, NLP)
 *
 * ENVIRONMENT FLAGS:
 *   - RESET_DB=false           Skip the destructive `pnpm test:db:reset`
 *                              (schema push + seed) step. Useful for
 *                              single-spec smoke runs against an already
 *                              seeded database.
 *   - SKIP_DB_PRECHECK=true|1  Skip the `pg_isready` reachability probe
 *                              entirely. Useful for HTTP-only specs (e.g.
 *                              `apps/api/tests/e2e/tenant-access-control.spec.ts`)
 *                              that talk to the API but don't require a live
 *                              Postgres on the test port. When set, the
 *                              schema-push/seed step is also skipped because
 *                              it implicitly depends on the same database.
 *                              Default: probe runs and hard-fails on miss.
 *   - E2E_WAIT_SERVICES=true   Additionally wait for Python micro-services
 *                              (STT-v2, SMR-v2, NLP) before starting the run.
 */

/**
 * NOTE: Environment variables should be loaded via dotenv-cli in package.json scripts:
 *   "test:e2e": "dotenv -e .env.test -- playwright test"
 *
 * This ensures consistent env loading and prevents the .env file from
 * overriding test configuration.
 */

import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';

if (process.env.NODE_ENV !== 'test') {
  console.warn(
    'WARNING: NODE_ENV is not "test". E2E tests should be run with dotenv-cli:\n' +
    '  pnpm test:e2e (which uses dotenv -e .env.test)'
  );
  process.env.NODE_ENV = 'test';
}

interface ServiceConfig {
  name: string;
  url: string;
  healthPath: string;
  envVar: string;
  required: boolean;
}

function getServiceConfigs(): ServiceConfig[] {
  return [
    {
      name: 'STT-v2',
      url: process.env.STT_V2_URL || 'http://localhost:8861',
      healthPath: '/api/v1/health',
      envVar: 'STT_V2_URL',
      required: false,
    },
    {
      name: 'SMR-v2',
      url: process.env.SMR_URL || 'http://localhost:8862',
      healthPath: '/api/v1/health',
      envVar: 'SMR_URL',
      required: false,
    },
    {
      name: 'NLP',
      url: process.env.NLP_URL || 'http://localhost:8864',
      healthPath: '/api/v1/health',
      envVar: 'NLP_URL',
      required: false,
    },
  ];
}

async function globalSetup(config: FullConfig): Promise<void> {
  console.log('\n🎭 Playwright E2E Test Setup\n');

  const baseURL =
    config.projects[0]?.use?.baseURL ||
    process.env.API_URL ||
    'http://localhost:8868';

  const isCI = process.env.CI === 'true';
  const waitForServices = process.env.E2E_WAIT_SERVICES === 'true';
  const skipDbPrecheck =
    process.env.SKIP_DB_PRECHECK === 'true' || process.env.SKIP_DB_PRECHECK === '1';

  if (isCI) {
    console.log('📦 CI Environment detected');
    console.log('   - Database and Redis provided by GitHub Actions services');
    console.log('   - Environment configured by setup-test-env action');
  } else {
    console.log('📦 Local Environment');
    console.log('   - Expecting test containers on ports 5433 (Postgres) and 6380 (Redis)');
    console.log('   - Run "pnpm docker:test:up" if not already running');
  }

  // Step 1: Verify database is accessible (unless explicitly opted out)
  if (skipDbPrecheck) {
    console.warn(
      '[playwright global-setup] SKIP_DB_PRECHECK=true — skipping pg_isready probe ' +
        'and the test:db:reset step. HTTP-only specs may proceed against an already-up API.'
    );
  } else {
    console.log('\n🔍 Step 1: Checking database connection...');
    const dbReady = await waitForDatabase();
    if (!dbReady) {
      console.error('❌ Database is not accessible!');
      if (!isCI) {
        console.error('   Run: pnpm docker:test:up');
        console.error('   To bypass for HTTP-only specs: SKIP_DB_PRECHECK=true pnpm test:e2e');
      }
      throw new Error('Database connection failed');
    }
    console.log('✅ Database is ready\n');

    // Step 2: Reset database — push schema and seed test data
    if (process.env.RESET_DB !== 'false') {
      console.log('📦 Step 2: Resetting database (schema push + seed)...');
      try {
        execSync('pnpm test:db:reset', {
          stdio: 'pipe',
          env: {
            ...process.env,
            PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
          },
          cwd: process.cwd(),
        });
        console.log('✅ Database reset and seeded\n');
      } catch (error) {
        console.warn('⚠️ Database reset failed:', (error as Error).message?.slice(0, 200));
        console.warn('   Some tests may fail if seeded data is missing\n');
      }
    }
  }

  // Step 3: Wait for API to be ready
  console.log(`🔍 Step 3: Waiting for API at ${baseURL}...`);
  const apiReady = await waitForService('API', baseURL, '/api/v1/health');
  if (!apiReady) {
    console.error('❌ API is not accessible!');
    if (!isCI) {
      console.error('   Start API with: pnpm dev:api:test');
    }
    throw new Error(`API at ${baseURL} is not available`);
  }
  console.log('✅ API is ready\n');

  // Step 4: Optionally wait for Python services
  if (waitForServices) {
    console.log('🔍 Step 4: Checking Python microservices...\n');
    const services = getServiceConfigs();
    const results = await Promise.all(
      services.map(async (svc) => {
        const ready = await waitForService(svc.name, svc.url, svc.healthPath, 30);
        return { ...svc, ready };
      })
    );

    for (const result of results) {
      if (result.ready) {
        console.log(`   ✅ ${result.name} is ready at ${result.url}`);
      } else if (result.required) {
        console.error(`   ❌ ${result.name} is not accessible at ${result.url}`);
        throw new Error(`Required service ${result.name} at ${result.url} is not available`);
      } else {
        console.warn(`   ⚠️ ${result.name} is not available (optional — tests requiring it will be skipped)`);
      }
    }
    console.log('');
  } else {
    console.log('ℹ️  Skipping Python service checks (set E2E_WAIT_SERVICES=true to enable)\n');
  }

  console.log('🎭 Playwright setup complete - ready to run tests!\n');
}

/**
 * Wait for a service to respond on its health endpoint
 */
async function waitForService(
  name: string,
  baseURL: string,
  healthPath: string,
  maxRetries = 60
): Promise<boolean> {
  const healthUrl = `${baseURL}${healthPath}`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }

    if (i > 0 && i % 10 === 0) {
      console.log(`  Still waiting for ${name}... (${i}/${maxRetries})`);
    }

    await sleep(1000);
  }

  return false;
}

/**
 * Wait for the database to be ready via `pg_isready`.
 *
 * Logs the exact command and port on the final miss so the developer can
 * diagnose without grepping through this helper.
 */
async function waitForDatabase(maxRetries = 30): Promise<boolean> {
  const port = process.env.DATABASE_URL?.includes('5433') ? '5433' : '5432';
  const cmd = `pg_isready -h localhost -p ${port} -U test`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      return true;
    } catch {
      // Not ready yet
    }

    if (i > 0 && i % 5 === 0) {
      console.log(`  Still waiting for database... (${i}/${maxRetries})`);
    }

    await sleep(1000);
  }

  console.error(`  Probe command:    ${cmd}`);
  console.error(`  Port:             ${port}`);
  console.error(`  Bypass for HTTP:  SKIP_DB_PRECHECK=true pnpm test:e2e`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default globalSetup;
