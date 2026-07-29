/**
 * Database Test Helpers
 *
 * Utilities for managing test database connections and state.
 * Updated for Prisma 7 with driver adapters.
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';

type CorePrismaClient = Awaited<ReturnType<typeof loadDatabase>>['client'];

let prisma: CorePrismaClient | null = null;

/**
 * Lazily load @arcaai/database to avoid CJS/ESM conflicts when Playwright
 * compiles test files to CJS but the database package is ESM-only.
 *
 * Uses the unscoped (platform-admin) client because test fixtures must
 * be able to set up rows across tenants before any CLS context exists.
 * TASK-305 B.4 allow-list — tests/ is a recognised legitimate caller.
 */
async function loadDatabase() {
  const db = await import('@arcaai/database');
  // eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 allow-list: e2e test helper, no CLS context available pre-request
  return { client: db.getPlatformAdminPrismaClient_Unscoped(), mod: db };
}

/**
 * Get or create a Prisma client instance for tests.
 * Must be called from an async context since the database module is loaded lazily.
 */
export async function getPrismaClient(): Promise<CorePrismaClient> {
  if (!prisma) {
    const { client } = await loadDatabase();
    prisma = client;
  }
  return prisma;
}

/**
 * Reset the database by truncating all tables
 * WARNING: This will delete all data in the database
 */
export async function resetDatabase(): Promise<void> {
  const client = await getPrismaClient();

  // Get all table names from both 'public' and 'core' schemas (excluding Prisma migrations table)
  const tables = await client.$queryRaw<Array<{ schemaname: string; tablename: string }>>`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname IN ('public', 'core')
    AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  // Disable foreign key checks
  await client.$executeRaw`SET session_replication_role = 'replica'`;

  // Truncate all tables
  for (const { schemaname, tablename } of tables) {
    try {
      await client.$executeRawUnsafe(`TRUNCATE TABLE "${schemaname}"."${tablename}" CASCADE`);
    } catch (error) {
      // Ignore errors for tables that might not exist
      console.warn(`Could not truncate table ${schemaname}.${tablename}:`, error);
    }
  }

  // Re-enable foreign key checks
  await client.$executeRaw`SET session_replication_role = 'origin'`;
}

/**
 * Push schema to database (creates tables without migrations)
 * This is useful for test databases where we want a fresh schema
 */
export async function pushSchema(): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), 'packages/database/src/prisma/db_main');

  try {
    console.log('Pushing schema to test database...');
    execSync(`pnpm prisma db push --schema=${schemaPath} --skip-generate --accept-data-loss`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      cwd: process.cwd(),
    });
    console.log('Schema pushed successfully');
  } catch (error) {
    console.error('Failed to push schema:', error);
    throw error;
  }
}

/**
 * Seed the test database with minimal required data
 */
export async function seedTestDatabase(): Promise<void> {
  try {
    console.log('Seeding test database...');
    execSync('pnpm test:db:seed', {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      cwd: process.cwd(),
    });
    console.log('Database seeded successfully');
  } catch (error) {
    console.error('Failed to seed test database:', error);
    throw error;
  }
}

/**
 * Run database migrations
 */
export async function runMigrations(): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), 'packages/database/src/prisma/db_main');

  try {
    console.log('Running database migrations...');
    execSync(`pnpm prisma migrate deploy --schema=${schemaPath}`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      cwd: process.cwd(),
    });
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Failed to run migrations:', error);
    throw error;
  }
}

/**
 * Setup test database - push schema and seed data
 * This is the main function to call before running E2E tests
 */
export async function setupTestDatabase(): Promise<void> {
  console.log('\n📦 Setting up test database...\n');

  // Wait for database to be ready
  await waitForDatabase();
  console.log('✅ Database is ready\n');

  // Push schema (creates tables)
  await pushSchema();
  console.log('');

  // Seed the database
  await seedTestDatabase();
  console.log('\n✅ Test database setup complete!\n');
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/**
 * Check if the database is connected and healthy
 */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    const client = await getPrismaClient();
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the database to be ready
 */
export async function waitForDatabase(maxRetries = 30, retryInterval = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await isDatabaseHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, retryInterval));
  }
  throw new Error('Database did not become ready in time');
}

/**
 * Execute a raw SQL query (use with caution)
 */
export async function executeRawQuery<T = unknown>(query: string): Promise<T> {
  const client = await getPrismaClient();
  return client.$queryRawUnsafe(query) as Promise<T>;
}

/**
 * Get the count of records in a table
 */
export async function getTableCount(tableName: string): Promise<number> {
  const client = await getPrismaClient();
  const result = await client.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) as count FROM "${tableName}"`);
  return Number(result[0]?.count || 0);
}

/**
 * Create a transaction wrapper for tests
 */
export async function withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const client = await getPrismaClient();
  return client.$transaction(fn as any);
}

/**
 * Service configuration for starting and health-checking test services.
 */
export interface TestServiceConfig {
  name: string;
  command: string[];
  baseUrl: string;
  healthPath: string;
  debugEnvVar: string;
}

const SERVICE_CONFIGS: Record<string, TestServiceConfig> = {
  api: {
    name: 'API',
    command: ['pnpm', '--filter', 'api', 'dev'],
    baseUrl: process.env.API_URL || 'http://localhost:8968',
    healthPath: '/api/v1/health',
    debugEnvVar: 'DEBUG_API',
  },
  stt: {
    name: 'STT',
    command: [
      'conda',
      'run',
      '-n',
      'arcaenv',
      '--no-capture-output',
      'uvicorn',
      'stt.main:app',
      '--host',
      '0.0.0.0',
      '--port',
      process.env.STT_PORT || '8861',
      '--app-dir',
      'apps/stt/src',
    ],
    baseUrl: process.env.STT_URL || 'http://localhost:8861',
    healthPath: '/api/v1/health',
    debugEnvVar: 'DEBUG_STT',
  },
  smr: {
    name: 'SMR',
    command: [
      'conda',
      'run',
      '-n',
      'arcaenv',
      '--no-capture-output',
      'uvicorn',
      'smr.main:app',
      '--host',
      '0.0.0.0',
      '--port',
      process.env.SMR_PORT || '8862',
      '--app-dir',
      'apps/smr/src',
    ],
    baseUrl: process.env.SMR_URL || 'http://localhost:8862',
    healthPath: '/api/v1/health',
    debugEnvVar: 'DEBUG_SMR',
  },
  nlp: {
    name: 'NLP',
    command: [
      'conda',
      'run',
      '-n',
      'arcaenv',
      '--no-capture-output',
      'uvicorn',
      '--factory',
      'nlp.app:get_app',
      '--host',
      '0.0.0.0',
      '--port',
      process.env.NLP_PORT || '8864',
      '--app-dir',
      'apps/nlp/src',
    ],
    baseUrl: process.env.NLP_URL || 'http://localhost:8864',
    healthPath: '/api/v1/health',
    debugEnvVar: 'DEBUG_NLP',
  },
};

/**
 * Start a test service by key ('api', 'stt', 'smr', 'nlp').
 * Returns the ChildProcess for lifecycle management.
 */
export function startTestService(serviceKey: keyof typeof SERVICE_CONFIGS): ChildProcess {
  const config = SERVICE_CONFIGS[serviceKey];
  if (!config) {
    throw new Error(`Unknown service: ${serviceKey}. Valid keys: ${Object.keys(SERVICE_CONFIGS).join(', ')}`);
  }

  console.log(`Starting ${config.name} server...`);

  const [cmd, ...args] = config.command;
  const svcProcess = spawn(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
    shell: true,
  });

  svcProcess.stdout?.on('data', (data) => {
    const output = data.toString();
    if (process.env[config.debugEnvVar]) {
      console.log(`[${config.name}] ${output}`);
    }
  });

  svcProcess.stderr?.on('data', (data) => {
    const output = data.toString();
    if (process.env[config.debugEnvVar] || output.includes('error')) {
      console.error(`[${config.name} Error] ${output}`);
    }
  });

  return svcProcess;
}

/**
 * Start the API server for E2E tests.
 * Convenience wrapper around startTestService('api').
 */
export function startApiServer(): ChildProcess {
  return startTestService('api');
}

/**
 * Wait for a service to become healthy by polling its health endpoint.
 */
export async function waitForService(name: string, baseUrl: string, healthPath: string, maxRetries = 60, retryInterval = 1000): Promise<void> {
  const healthUrl = `${baseUrl}${healthPath}`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        console.log(`✅ ${name} is ready at ${baseUrl}`);
        return;
      }
    } catch {
      // Not ready yet
    }

    if (i > 0 && i % 10 === 0) {
      console.log(`  Waiting for ${name}... (${i}/${maxRetries})`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryInterval));
  }

  throw new Error(`${name} at ${baseUrl} did not become ready within ${maxRetries} seconds`);
}

/**
 * Wait for the API to be ready.
 * Convenience wrapper around waitForService.
 */
export async function waitForApi(
  baseUrl: string = process.env.API_URL || 'http://localhost:8968',
  maxRetries = 60,
  retryInterval = 1000,
): Promise<void> {
  return waitForService('API', baseUrl, '/api/v1/health', maxRetries, retryInterval);
}

/**
 * Wait for a Python microservice to be ready by service key.
 */
export async function waitForMicroservice(serviceKey: 'stt' | 'smr' | 'nlp', maxRetries = 60, retryInterval = 1000): Promise<void> {
  const config = SERVICE_CONFIGS[serviceKey];
  if (!config) {
    throw new Error(`Unknown service: ${serviceKey}`);
  }
  return waitForService(config.name, config.baseUrl, config.healthPath, maxRetries, retryInterval);
}

/**
 * Check if a microservice is currently available (non-blocking).
 */
export async function isServiceHealthy(serviceKey: keyof typeof SERVICE_CONFIGS): Promise<boolean> {
  const config = SERVICE_CONFIGS[serviceKey];
  if (!config) return false;

  try {
    const response = await fetch(`${config.baseUrl}${config.healthPath}`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get the configuration for a service by key.
 */
export function getServiceConfig(serviceKey: keyof typeof SERVICE_CONFIGS): TestServiceConfig | undefined {
  return SERVICE_CONFIGS[serviceKey];
}
