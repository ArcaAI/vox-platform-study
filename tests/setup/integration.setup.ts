/**
 * Integration Test Setup
 *
 * This file is loaded before integration tests run.
 * It handles database connections and cleanup.
 *
 * NOTE: Environment variables should be loaded via dotenv-cli in package.json scripts:
 *   "test:integration": "dotenv -e .env.test -- vitest run --config vitest.integration.config.ts"
 *
 * This ensures consistent env loading and prevents the .env file from
 * overriding test configuration.
 */

import { beforeAll, afterAll, beforeEach } from 'vitest';
import { getPrismaClient, disconnectDatabase, resetDatabase } from '../helpers/db.helper';

// Verify test environment is set (should be set by dotenv-cli)
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    'WARNING: NODE_ENV is not "test". Tests should be run with dotenv-cli:\n' +
    '  pnpm test:integration (which uses dotenv -e .env.test)'
  );
  process.env.NODE_ENV = 'test';
}

// Ensure we're using test database
if (!process.env.DATABASE_URL?.includes('test')) {
  throw new Error(
    'Integration tests must use a test database. DATABASE_URL must contain "test".'
  );
}

beforeAll(async () => {
  const prisma = await getPrismaClient();

  try {
    await prisma.$connect();
    console.log('Database connected for integration tests');
  } catch (error) {
    console.error('Failed to connect to test database:', error);
    throw error;
  }
});

beforeEach(async () => {
  // Reset database state before each test
  await resetDatabase();
});

afterAll(async () => {
  // Cleanup database connection
  await disconnectDatabase();
  console.log('Database disconnected after integration tests');
});
