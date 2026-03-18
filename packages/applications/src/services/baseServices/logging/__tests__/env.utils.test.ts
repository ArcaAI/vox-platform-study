/**
 * Environment Utilities Unit Tests
 *
 * Tests for the environment variable helper functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getEnvString,
    getEnvBoolean,
    getEnvNumber,
    isDevelopment,
    isProduction,
} from '../env.utils';

describe('env.utils', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset process.env before each test
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('getEnvString', () => {
        it('should return environment variable value when set', () => {
            process.env.TEST_STRING = 'hello';
            expect(getEnvString('TEST_STRING')).toBe('hello');
        });

        it('should return default value when environment variable is not set', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvString('TEST_MISSING', 'default')).toBe('default');
        });

        it('should return undefined when no default and env var not set', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvString('TEST_MISSING')).toBeUndefined();
        });

        it('should return empty string when env var is empty', () => {
            process.env.TEST_EMPTY = '';
            expect(getEnvString('TEST_EMPTY')).toBe('');
        });

        it('should return env var value even when default is provided', () => {
            process.env.TEST_STRING = 'actual';
            expect(getEnvString('TEST_STRING', 'default')).toBe('actual');
        });

        it('should handle whitespace in values', () => {
            process.env.TEST_WHITESPACE = '  spaced  ';
            expect(getEnvString('TEST_WHITESPACE')).toBe('  spaced  ');
        });

        it('should handle special characters', () => {
            process.env.TEST_SPECIAL = 'user:password@host:5432/db';
            expect(getEnvString('TEST_SPECIAL')).toBe('user:password@host:5432/db');
        });
    });

    describe('getEnvBoolean', () => {
        it('should return true for "true"', () => {
            process.env.TEST_BOOL = 'true';
            expect(getEnvBoolean('TEST_BOOL')).toBe(true);
        });

        it('should return true for "TRUE"', () => {
            process.env.TEST_BOOL = 'TRUE';
            expect(getEnvBoolean('TEST_BOOL')).toBe(true);
        });

        it('should return true for "True"', () => {
            process.env.TEST_BOOL = 'True';
            expect(getEnvBoolean('TEST_BOOL')).toBe(true);
        });

        it('should return true for "1"', () => {
            process.env.TEST_BOOL = '1';
            expect(getEnvBoolean('TEST_BOOL')).toBe(true);
        });

        it('should return false for "false"', () => {
            process.env.TEST_BOOL = 'false';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);
        });

        it('should return false for "FALSE"', () => {
            process.env.TEST_BOOL = 'FALSE';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);
        });

        it('should return false for "0"', () => {
            process.env.TEST_BOOL = '0';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);
        });

        it('should return false for any other value', () => {
            process.env.TEST_BOOL = 'yes';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);

            process.env.TEST_BOOL = 'no';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);

            process.env.TEST_BOOL = 'random';
            expect(getEnvBoolean('TEST_BOOL')).toBe(false);
        });

        it('should return default value when env var not set', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvBoolean('TEST_MISSING', true)).toBe(true);
            expect(getEnvBoolean('TEST_MISSING', false)).toBe(false);
        });

        it('should return false as default when no default provided', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvBoolean('TEST_MISSING')).toBe(false);
        });

        it('should handle empty string as false', () => {
            process.env.TEST_EMPTY = '';
            expect(getEnvBoolean('TEST_EMPTY')).toBe(false);
        });
    });

    describe('getEnvNumber', () => {
        it('should return parsed integer value', () => {
            process.env.TEST_NUM = '42';
            expect(getEnvNumber('TEST_NUM')).toBe(42);
        });

        it('should return default value when env var not set', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvNumber('TEST_MISSING', 100)).toBe(100);
        });

        it('should return undefined when no default and env var not set', () => {
            delete process.env.TEST_MISSING;
            expect(getEnvNumber('TEST_MISSING')).toBeUndefined();
        });

        it('should return default value for non-numeric strings', () => {
            process.env.TEST_NAN = 'not-a-number';
            expect(getEnvNumber('TEST_NAN', 50)).toBe(50);
        });

        it('should handle negative numbers', () => {
            process.env.TEST_NEG = '-10';
            expect(getEnvNumber('TEST_NEG')).toBe(-10);
        });

        it('should handle zero', () => {
            process.env.TEST_ZERO = '0';
            expect(getEnvNumber('TEST_ZERO')).toBe(0);
        });

        it('should truncate decimal numbers to integers', () => {
            process.env.TEST_DECIMAL = '3.14';
            expect(getEnvNumber('TEST_DECIMAL')).toBe(3);
        });

        it('should handle large numbers', () => {
            process.env.TEST_LARGE = '1000000';
            expect(getEnvNumber('TEST_LARGE')).toBe(1000000);
        });

        it('should return default for empty string', () => {
            process.env.TEST_EMPTY = '';
            expect(getEnvNumber('TEST_EMPTY', 25)).toBe(25);
        });

        it('should handle whitespace around numbers', () => {
            process.env.TEST_WHITESPACE = '  123  ';
            expect(getEnvNumber('TEST_WHITESPACE')).toBe(123);
        });
    });

    describe('isDevelopment', () => {
        it('should return true when NODE_ENV is "development"', () => {
            process.env.NODE_ENV = 'development';
            expect(isDevelopment()).toBe(true);
        });

        it('should return false when NODE_ENV is "production"', () => {
            process.env.NODE_ENV = 'production';
            expect(isDevelopment()).toBe(false);
        });

        it('should return false when NODE_ENV is "test"', () => {
            process.env.NODE_ENV = 'test';
            expect(isDevelopment()).toBe(false);
        });

        it('should return false when NODE_ENV is not set', () => {
            delete process.env.NODE_ENV;
            expect(isDevelopment()).toBe(false);
        });

        it('should be case-sensitive', () => {
            process.env.NODE_ENV = 'Development';
            expect(isDevelopment()).toBe(false);

            process.env.NODE_ENV = 'DEVELOPMENT';
            expect(isDevelopment()).toBe(false);
        });
    });

    describe('isProduction', () => {
        it('should return true when NODE_ENV is "production"', () => {
            process.env.NODE_ENV = 'production';
            expect(isProduction()).toBe(true);
        });

        it('should return false when NODE_ENV is "development"', () => {
            process.env.NODE_ENV = 'development';
            expect(isProduction()).toBe(false);
        });

        it('should return false when NODE_ENV is "test"', () => {
            process.env.NODE_ENV = 'test';
            expect(isProduction()).toBe(false);
        });

        it('should return false when NODE_ENV is not set', () => {
            delete process.env.NODE_ENV;
            expect(isProduction()).toBe(false);
        });

        it('should be case-sensitive', () => {
            process.env.NODE_ENV = 'Production';
            expect(isProduction()).toBe(false);

            process.env.NODE_ENV = 'PRODUCTION';
            expect(isProduction()).toBe(false);
        });
    });
});
