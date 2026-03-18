/**
 * Environment Loading Utility Tests
 *
 * Tests for the env.ts module that handles loading environment variables
 * from the correct .env file based on NODE_ENV.
 *
 * These tests import and test the ACTUAL functions from env.ts,
 * not duplicated versions.
 *
 * Test Coverage:
 * - Environment file mapping
 * - CI environment detection
 * - NODE_ENV detection and fallback
 * - Monorepo root detection
 * - Environment loading behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

// Mock dotenv before importing the module
vi.mock('dotenv', () => ({
  default: {
    config: vi.fn().mockReturnValue({ parsed: {} }),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Import the actual functions from env.ts
import {
  ENV_FILE_MAP,
  isCI,
  getNodeEnv,
  findMonorepoRoot,
  loadDatabaseEnv,
  type Environment,
} from '../env';

describe('Environment Loading Utility', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('ENV_FILE_MAP', () => {
    it('should map development to .env.dev', () => {
      expect(ENV_FILE_MAP['development']).toBe('.env.dev');
    });

    it('should map test to .env.test', () => {
      expect(ENV_FILE_MAP['test']).toBe('.env.test');
    });

    it('should map production to .env.production', () => {
      expect(ENV_FILE_MAP['production']).toBe('.env.production');
    });

    it('should map staging to .env.staging', () => {
      expect(ENV_FILE_MAP['staging']).toBe('.env.staging');
    });

    it('should have exactly 4 environment mappings', () => {
      expect(Object.keys(ENV_FILE_MAP)).toHaveLength(4);
    });
  });

  describe('isCI', () => {
    it('should return true when CI=true', () => {
      process.env.CI = 'true';
      expect(isCI()).toBe(true);
    });

    it('should return true when CI=1', () => {
      process.env.CI = '1';
      expect(isCI()).toBe(true);
    });

    it('should return false when CI is not set', () => {
      delete process.env.CI;
      expect(isCI()).toBe(false);
    });

    it('should return false when CI=false', () => {
      process.env.CI = 'false';
      expect(isCI()).toBe(false);
    });

    it('should return false when CI is empty string', () => {
      process.env.CI = '';
      expect(isCI()).toBe(false);
    });
  });

  describe('getNodeEnv', () => {
    it('should return development when NODE_ENV=development', () => {
      process.env.NODE_ENV = 'development';
      expect(getNodeEnv()).toBe('development');
    });

    it('should return test when NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      expect(getNodeEnv()).toBe('test');
    });

    it('should return production when NODE_ENV=production', () => {
      process.env.NODE_ENV = 'production';
      expect(getNodeEnv()).toBe('production');
    });

    it('should return staging when NODE_ENV=staging', () => {
      process.env.NODE_ENV = 'staging';
      expect(getNodeEnv()).toBe('staging');
    });

    it('should default to development when NODE_ENV is not set', () => {
      delete process.env.NODE_ENV;
      expect(getNodeEnv()).toBe('development');
    });

    it('should default to development when NODE_ENV is invalid', () => {
      process.env.NODE_ENV = 'invalid_env';
      expect(getNodeEnv()).toBe('development');
    });

    it('should default to development when NODE_ENV is empty string', () => {
      process.env.NODE_ENV = '';
      expect(getNodeEnv()).toBe('development');
    });
  });

  describe('findMonorepoRoot', () => {
    it('should find monorepo root when package.json exists with correct name', () => {
      const mockFs = vi.mocked(fs);
      const testDir = '/test/project/packages/database';

      mockFs.existsSync.mockImplementation((filePath) => {
        return filePath === '/test/project/package.json';
      });

      mockFs.readFileSync.mockImplementation((filePath) => {
        if (filePath === '/test/project/package.json') {
          return JSON.stringify({ name: 'hope-monorepo' });
        }
        throw new Error('File not found');
      });

      const result = findMonorepoRoot(testDir);
      expect(result).toBe('/test/project');
    });

    it('should return null when no monorepo root is found', () => {
      const mockFs = vi.mocked(fs);

      mockFs.existsSync.mockReturnValue(false);

      const result = findMonorepoRoot('/some/random/path');
      expect(result).toBeNull();
    });

    it('should return null when package.json has wrong name', () => {
      const mockFs = vi.mocked(fs);
      const testDir = '/test/project';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'other-project' }));

      const result = findMonorepoRoot(testDir);
      expect(result).toBeNull();
    });

    it('should handle JSON parse errors gracefully', () => {
      const mockFs = vi.mocked(fs);
      const testDir = '/test/project';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json {{{');

      const result = findMonorepoRoot(testDir);
      expect(result).toBeNull();
    });

    it('should respect max depth limit', () => {
      const mockFs = vi.mocked(fs);

      // Always return false for existsSync to simulate no package.json found
      mockFs.existsSync.mockReturnValue(false);

      // Start from a deep path
      const deepPath = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p';
      const result = findMonorepoRoot(deepPath);

      // Should return null after max depth (10) iterations
      expect(result).toBeNull();
    });
  });

  describe('loadDatabaseEnv', () => {
    it('should skip loading in CI environment', () => {
      process.env.CI = 'true';
      process.env.NODE_ENV = 'development';

      const result = loadDatabaseEnv();
      expect(result.loaded).toBe(false);
    });

    it('should skip loading in production environment', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CI;

      const result = loadDatabaseEnv();
      expect(result.loaded).toBe(false);
    });

    it('should return loaded: false when monorepo root is not found', () => {
      const mockFs = vi.mocked(fs);
      process.env.NODE_ENV = 'development';
      delete process.env.CI;

      mockFs.existsSync.mockReturnValue(false);

      const result = loadDatabaseEnv();
      expect(result.loaded).toBe(false);
    });
  });
});

describe('Environment Configuration Documentation', () => {
  it('should document environment file convention', () => {
    // Verify the actual ENV_FILE_MAP matches documentation
    expect(ENV_FILE_MAP.development).toBe('.env.dev');
    expect(ENV_FILE_MAP.test).toBe('.env.test');
    expect(ENV_FILE_MAP.production).toBe('.env.production');
    expect(ENV_FILE_MAP.staging).toBe('.env.staging');
  });

  it('should have all expected environment types', () => {
    const expectedEnvironments: Environment[] = ['development', 'test', 'production', 'staging'];

    expectedEnvironments.forEach((env) => {
      expect(ENV_FILE_MAP[env]).toBeDefined();
    });
  });
});
