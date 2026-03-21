/**
 * Types Unit Tests
 *
 * Tests for the logging type utilities and constants.
 */

import { describe, it, expect } from 'vitest';
import {
    LOG_LEVEL_VALUES,
    numericToLevel,
    shouldLogLevel,
    type LogLevel,
} from '../transports/types';

describe('types', () => {
    describe('LOG_LEVEL_VALUES', () => {
        it('should have correct numeric values for all log levels', () => {
            expect(LOG_LEVEL_VALUES.trace).toBe(10);
            expect(LOG_LEVEL_VALUES.debug).toBe(20);
            expect(LOG_LEVEL_VALUES.info).toBe(30);
            expect(LOG_LEVEL_VALUES.warn).toBe(40);
            expect(LOG_LEVEL_VALUES.error).toBe(50);
            expect(LOG_LEVEL_VALUES.fatal).toBe(60);
        });

        it('should have all expected log levels', () => {
            const expectedLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
            const actualLevels = Object.keys(LOG_LEVEL_VALUES);

            expect(actualLevels).toHaveLength(expectedLevels.length);
            expectedLevels.forEach(level => {
                expect(actualLevels).toContain(level);
            });
        });

        it('should have levels in ascending order of severity', () => {
            expect(LOG_LEVEL_VALUES.trace).toBeLessThan(LOG_LEVEL_VALUES.debug);
            expect(LOG_LEVEL_VALUES.debug).toBeLessThan(LOG_LEVEL_VALUES.info);
            expect(LOG_LEVEL_VALUES.info).toBeLessThan(LOG_LEVEL_VALUES.warn);
            expect(LOG_LEVEL_VALUES.warn).toBeLessThan(LOG_LEVEL_VALUES.error);
            expect(LOG_LEVEL_VALUES.error).toBeLessThan(LOG_LEVEL_VALUES.fatal);
        });
    });

    describe('numericToLevel', () => {
        it('should convert numeric values to correct log levels', () => {
            expect(numericToLevel(10)).toBe('trace');
            expect(numericToLevel(20)).toBe('debug');
            expect(numericToLevel(30)).toBe('info');
            expect(numericToLevel(40)).toBe('warn');
            expect(numericToLevel(50)).toBe('error');
            expect(numericToLevel(60)).toBe('fatal');
        });

        it('should handle values between thresholds', () => {
            // Values between levels should round down to the lower level
            expect(numericToLevel(15)).toBe('trace'); // Between trace(10) and debug(20)
            expect(numericToLevel(25)).toBe('debug'); // Between debug(20) and info(30)
            expect(numericToLevel(35)).toBe('info');  // Between info(30) and warn(40)
            expect(numericToLevel(45)).toBe('warn');  // Between warn(40) and error(50)
            expect(numericToLevel(55)).toBe('error'); // Between error(50) and fatal(60)
        });

        it('should handle values above fatal', () => {
            expect(numericToLevel(70)).toBe('fatal');
            expect(numericToLevel(100)).toBe('fatal');
            expect(numericToLevel(1000)).toBe('fatal');
        });

        it('should handle values below trace', () => {
            expect(numericToLevel(5)).toBe('trace');
            expect(numericToLevel(1)).toBe('trace');
            expect(numericToLevel(0)).toBe('trace');
            expect(numericToLevel(-10)).toBe('trace');
        });

        it('should handle exact boundary values', () => {
            expect(numericToLevel(10)).toBe('trace');
            expect(numericToLevel(20)).toBe('debug');
            expect(numericToLevel(30)).toBe('info');
            expect(numericToLevel(40)).toBe('warn');
            expect(numericToLevel(50)).toBe('error');
            expect(numericToLevel(60)).toBe('fatal');
        });
    });

    describe('shouldLogLevel', () => {
        it('should return true when level equals minimum level', () => {
            expect(shouldLogLevel('trace', 'trace')).toBe(true);
            expect(shouldLogLevel('debug', 'debug')).toBe(true);
            expect(shouldLogLevel('info', 'info')).toBe(true);
            expect(shouldLogLevel('warn', 'warn')).toBe(true);
            expect(shouldLogLevel('error', 'error')).toBe(true);
            expect(shouldLogLevel('fatal', 'fatal')).toBe(true);
        });

        it('should return true when level is higher than minimum level', () => {
            expect(shouldLogLevel('debug', 'trace')).toBe(true);
            expect(shouldLogLevel('info', 'trace')).toBe(true);
            expect(shouldLogLevel('warn', 'trace')).toBe(true);
            expect(shouldLogLevel('error', 'trace')).toBe(true);
            expect(shouldLogLevel('fatal', 'trace')).toBe(true);

            expect(shouldLogLevel('info', 'debug')).toBe(true);
            expect(shouldLogLevel('warn', 'debug')).toBe(true);
            expect(shouldLogLevel('error', 'debug')).toBe(true);
            expect(shouldLogLevel('fatal', 'debug')).toBe(true);

            expect(shouldLogLevel('warn', 'info')).toBe(true);
            expect(shouldLogLevel('error', 'info')).toBe(true);
            expect(shouldLogLevel('fatal', 'info')).toBe(true);

            expect(shouldLogLevel('error', 'warn')).toBe(true);
            expect(shouldLogLevel('fatal', 'warn')).toBe(true);

            expect(shouldLogLevel('fatal', 'error')).toBe(true);
        });

        it('should return false when level is lower than minimum level', () => {
            expect(shouldLogLevel('trace', 'debug')).toBe(false);
            expect(shouldLogLevel('trace', 'info')).toBe(false);
            expect(shouldLogLevel('trace', 'warn')).toBe(false);
            expect(shouldLogLevel('trace', 'error')).toBe(false);
            expect(shouldLogLevel('trace', 'fatal')).toBe(false);

            expect(shouldLogLevel('debug', 'info')).toBe(false);
            expect(shouldLogLevel('debug', 'warn')).toBe(false);
            expect(shouldLogLevel('debug', 'error')).toBe(false);
            expect(shouldLogLevel('debug', 'fatal')).toBe(false);

            expect(shouldLogLevel('info', 'warn')).toBe(false);
            expect(shouldLogLevel('info', 'error')).toBe(false);
            expect(shouldLogLevel('info', 'fatal')).toBe(false);

            expect(shouldLogLevel('warn', 'error')).toBe(false);
            expect(shouldLogLevel('warn', 'fatal')).toBe(false);

            expect(shouldLogLevel('error', 'fatal')).toBe(false);
        });

        it('should work correctly with trace as minimum (logs everything)', () => {
            const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
            levels.forEach(level => {
                expect(shouldLogLevel(level, 'trace')).toBe(true);
            });
        });

        it('should work correctly with fatal as minimum (logs only fatal)', () => {
            expect(shouldLogLevel('trace', 'fatal')).toBe(false);
            expect(shouldLogLevel('debug', 'fatal')).toBe(false);
            expect(shouldLogLevel('info', 'fatal')).toBe(false);
            expect(shouldLogLevel('warn', 'fatal')).toBe(false);
            expect(shouldLogLevel('error', 'fatal')).toBe(false);
            expect(shouldLogLevel('fatal', 'fatal')).toBe(true);
        });
    });
});
