/**
 * API Integration Test Setup
 *
 * This file is loaded before API integration tests run.
 *
 * NOTE: Environment variables should be loaded via dotenv-cli in package.json scripts.
 * This ensures consistent env loading and prevents the .env file from
 * overriding test configuration.
 */

import { beforeAll, afterAll, beforeEach } from 'vitest';

// Re-export from shared helpers
export * from '../../../../tests/helpers';
export * from '../../../../tests/fixtures';

// Verify test environment is set (should be set by dotenv-cli)
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    'WARNING: NODE_ENV is not "test". Tests should be run with dotenv-cli.'
  );
  process.env.NODE_ENV = 'test';
}

// Ensure we're using test database
if (!process.env.DATABASE_URL?.includes('test')) {
  console.warn(
    'WARNING: DATABASE_URL does not contain "test". Make sure you are using the test database.'
  );
}

beforeAll(async () => {
  console.log('Starting API integration tests...');
});

afterAll(async () => {
  console.log('API integration tests completed.');
});
