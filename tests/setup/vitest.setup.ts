/**
 * Global Vitest Setup
 *
 * This file is loaded before all tests run.
 * Use it for global configuration and setup.
 *
 * NOTE: Environment variables should be loaded via dotenv-cli in package.json scripts:
 *   "test:unit": "dotenv -e .env.test -- vitest run ..."
 *
 * This ensures consistent env loading and prevents the .env file from
 * overriding test configuration.
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Verify test environment is set (should be set by dotenv-cli)
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    'WARNING: NODE_ENV is not "test". Tests should be run with dotenv-cli:\n' +
    '  pnpm test:unit (which uses dotenv -e .env.test)'
  );
  process.env.NODE_ENV = 'test';
}

// Node 25+ ships a native localStorage on globalThis that has no working
// methods unless --localstorage-file is provided. When vitest uses jsdom the
// environment normally supplies a working Storage, but the native getter can
// shadow it. Patch it here so every workspace project gets a functional mock.
if (typeof globalThis.localStorage === 'undefined' ||
    typeof globalThis.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {};
  const localStorageFallback = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageFallback,
    writable: true,
    configurable: true,
  });
}

// Global test setup
beforeAll(async () => {
  // Any global setup needed before all tests
});

afterAll(async () => {
  // Any global cleanup needed after all tests
});

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Global test utilities
declare global {
  // Add any global test utilities here
  var testUtils: {
    sleep: (ms: number) => Promise<void>;
  };
}

globalThis.testUtils = {
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
