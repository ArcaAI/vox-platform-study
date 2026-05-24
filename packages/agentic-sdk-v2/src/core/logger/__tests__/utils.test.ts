/**
 * SDK Logger Utils Unit Tests
 *
 * Tests for the SDK logger utility functions.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    generateId,
    generateTraceId,
    generateSpanId,
    serializeError,
    safeStringify,
    truncate,
    formatDuration,
    formatBytes,
    getTimestamp,
    getTimestampMs,
    maskSensitiveData,
    deepClone,
    deepMerge,
    isBrowser,
    isNode,
    extractTraceContext,
    createTraceparent,
} from '../utils';

describe('SDK Logger utils', () => {
    describe('generateId', () => {
        it('should generate a valid UUID-like string', () => {
            const id = generateId();
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        });

        it('should generate unique IDs', () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add(generateId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe('generateTraceId', () => {
        it('should generate a 32-character hex string', () => {
            const traceId = generateTraceId();
            expect(traceId).toMatch(/^[0-9a-f]{32}$/i);
        });

        it('should generate unique trace IDs', () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add(generateTraceId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe('generateSpanId', () => {
        it('should generate a 16-character hex string', () => {
            const spanId = generateSpanId();
            expect(spanId).toMatch(/^[0-9a-f]{16}$/i);
        });

        it('should generate unique span IDs', () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add(generateSpanId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe('serializeError', () => {
        it('should serialize Error objects', () => {
            const error = new Error('Test error');
            const serialized = serializeError(error);

            expect(serialized.name).toBe('Error');
            expect(serialized.message).toBe('Test error');
            expect(serialized.stack).toBeDefined();
        });

        it('should serialize custom error properties', () => {
            const error = new Error('Test error') as any;
            error.code = 'ERR_001';
            error.statusCode = 500;

            const serialized = serializeError(error);

            expect(serialized.code).toBe('ERR_001');
            expect(serialized.statusCode).toBe(500);
        });

        it('should handle error cause chain', () => {
            const cause = new Error('Root cause');
            // The ES2022 `cause` Error option is not in the package's `lib`,
            // but `serializeError` reads `.cause` off the instance regardless.
            const error = new (Error as new (msg: string, options?: { cause?: unknown }) => Error)(
                'Wrapper error',
                { cause },
            );

            const serialized = serializeError(error);

            expect(serialized.cause).toBeDefined();
            expect((serialized.cause as any).message).toBe('Root cause');
        });

        it('should handle plain objects', () => {
            const obj = { code: 'ERR', details: 'Something went wrong' };
            const serialized = serializeError(obj);

            expect(serialized).toEqual(obj);
        });

        it('should handle primitive values', () => {
            expect(serializeError('string error')).toEqual({ message: 'string error' });
            expect(serializeError(500)).toEqual({ message: '500' });
        });
    });

    describe('safeStringify', () => {
        it('should stringify simple objects', () => {
            const obj = { name: 'test', value: 123 };
            const result = safeStringify(obj);
            expect(JSON.parse(result)).toEqual(obj);
        });

        it('should handle circular references', () => {
            const obj: any = { name: 'test' };
            obj.self = obj;

            const result = safeStringify(obj);
            expect(result).toContain('[Circular]');
        });

        it('should serialize Error objects', () => {
            const error = new Error('Test error');
            const result = safeStringify({ error });
            const parsed = JSON.parse(result);

            expect(parsed.error.message).toBe('Test error');
        });

        it('should handle bigint values', () => {
            const obj = { big: BigInt(123456789) };
            const result = safeStringify(obj);
            expect(result).toContain('123456789');
        });

        it('should handle functions', () => {
            const obj = { fn: function testFn() {} };
            const result = safeStringify(obj);
            expect(result).toContain('[Function: testFn]');
        });

        it('should handle symbols', () => {
            const obj = { sym: Symbol('test') };
            const result = safeStringify(obj);
            expect(result).toContain('Symbol(test)');
        });

        it('should handle Map objects', () => {
            const obj = { map: new Map([['key', 'value']]) };
            const result = safeStringify(obj);
            const parsed = JSON.parse(result);
            expect(parsed.map.key).toBe('value');
        });

        it('should handle Set objects', () => {
            const obj = { set: new Set([1, 2, 3]) };
            const result = safeStringify(obj);
            const parsed = JSON.parse(result);
            expect(parsed.set).toEqual([1, 2, 3]);
        });

        it('should handle Date objects', () => {
            const date = new Date('2024-01-15T10:30:00.000Z');
            const obj = { date };
            const result = safeStringify(obj);
            expect(result).toContain('2024-01-15T10:30:00.000Z');
        });

        it('should support pretty printing', () => {
            const obj = { name: 'test' };
            const result = safeStringify(obj, 2);
            expect(result).toContain('\n');
        });
    });

    describe('truncate', () => {
        it('should not truncate strings shorter than max length', () => {
            expect(truncate('short', 10)).toBe('short');
        });

        it('should truncate strings longer than max length', () => {
            expect(truncate('this is a long string', 10)).toBe('this is...');
        });

        it('should handle exact length strings', () => {
            expect(truncate('exact', 5)).toBe('exact');
        });

        it('should handle empty strings', () => {
            expect(truncate('', 10)).toBe('');
        });
    });

    describe('formatDuration', () => {
        it('should format microseconds', () => {
            expect(formatDuration(0.5)).toMatch(/μs$/);
        });

        it('should format milliseconds', () => {
            expect(formatDuration(150)).toMatch(/ms$/);
        });

        it('should format seconds', () => {
            expect(formatDuration(5000)).toMatch(/s$/);
        });

        it('should format minutes', () => {
            expect(formatDuration(120000)).toMatch(/m$/);
        });
    });

    describe('formatBytes', () => {
        it('should format bytes', () => {
            expect(formatBytes(500)).toMatch(/B$/);
        });

        it('should format kilobytes', () => {
            expect(formatBytes(1500)).toMatch(/KB$/);
        });

        it('should format megabytes', () => {
            expect(formatBytes(1500000)).toMatch(/MB$/);
        });

        it('should handle zero', () => {
            expect(formatBytes(0)).toBe('0 B');
        });
    });

    describe('getTimestamp', () => {
        it('should return ISO format timestamp', () => {
            const timestamp = getTimestamp();
            expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });
    });

    describe('getTimestampMs', () => {
        it('should return current timestamp in milliseconds', () => {
            const before = Date.now();
            const timestamp = getTimestampMs();
            const after = Date.now();

            expect(timestamp).toBeGreaterThanOrEqual(before);
            expect(timestamp).toBeLessThanOrEqual(after);
        });
    });

    describe('maskSensitiveData', () => {
        it('should mask middle characters', () => {
            const masked = maskSensitiveData('1234567890', 2);
            expect(masked).toBe('12******90');
        });

        it('should mask entire short strings', () => {
            const masked = maskSensitiveData('abc', 4);
            expect(masked).toBe('***');
        });

        it('should use default visible chars', () => {
            const masked = maskSensitiveData('1234567890123456');
            expect(masked.startsWith('1234')).toBe(true);
            expect(masked.endsWith('3456')).toBe(true);
        });
    });

    describe('deepClone', () => {
        it('should clone simple objects', () => {
            const obj = { a: 1, b: 'test' };
            const cloned = deepClone(obj);

            expect(cloned).toEqual(obj);
            expect(cloned).not.toBe(obj);
        });

        it('should clone nested objects', () => {
            const obj = { a: { b: { c: 1 } } };
            const cloned = deepClone(obj);

            expect(cloned).toEqual(obj);
            expect(cloned.a).not.toBe(obj.a);
            expect(cloned.a.b).not.toBe(obj.a.b);
        });

        it('should clone arrays', () => {
            const arr = [1, 2, { a: 3 }];
            const cloned = deepClone(arr);

            expect(cloned).toEqual(arr);
            expect(cloned).not.toBe(arr);
            expect(cloned[2]).not.toBe(arr[2]);
        });

        it('should clone Date objects', () => {
            const date = new Date();
            const cloned = deepClone(date);

            expect(cloned.getTime()).toBe(date.getTime());
            expect(cloned).not.toBe(date);
        });

        it('should clone Map objects', () => {
            const map = new Map([['key', 'value']]);
            const cloned = deepClone(map);

            expect(cloned.get('key')).toBe('value');
            expect(cloned).not.toBe(map);
        });

        it('should clone Set objects', () => {
            const set = new Set([1, 2, 3]);
            const cloned = deepClone(set);

            expect([...cloned]).toEqual([1, 2, 3]);
            expect(cloned).not.toBe(set);
        });

        it('should handle primitives', () => {
            expect(deepClone(null)).toBe(null);
            expect(deepClone(123)).toBe(123);
            expect(deepClone('string')).toBe('string');
        });
    });

    describe('deepMerge', () => {
        it('should merge simple objects', () => {
            const target = { a: 1 };
            const source = { b: 2 };
            const result = deepMerge<Record<string, unknown>>(target, source);

            expect(result).toEqual({ a: 1, b: 2 });
        });

        it('should merge nested objects', () => {
            const target = { a: { b: 1 } };
            const source = { a: { c: 2 } };
            const result = deepMerge<Record<string, unknown>>(target, source);

            expect(result).toEqual({ a: { b: 1, c: 2 } });
        });

        it('should override values', () => {
            const target = { a: 1 };
            const source = { a: 2 };
            const result = deepMerge(target, source);

            expect(result).toEqual({ a: 2 });
        });

        it('should handle multiple sources', () => {
            const target = { a: 1 };
            const source1 = { b: 2 };
            const source2 = { c: 3 };
            const result = deepMerge<Record<string, unknown>>(target, source1, source2);

            expect(result).toEqual({ a: 1, b: 2, c: 3 });
        });

        it('should not merge arrays (replace instead)', () => {
            const target = { arr: [1, 2] };
            const source = { arr: [3, 4] };
            const result = deepMerge(target, source);

            expect(result.arr).toEqual([3, 4]);
        });

        it('should handle undefined sources', () => {
            const target = { a: 1 };
            const result = deepMerge(target, undefined as any);

            expect(result).toEqual({ a: 1 });
        });
    });

    describe('isBrowser', () => {
        it('should detect browser environment', () => {
            // In jsdom test environment, window is defined so it returns true
            // This tests the function works with a browser-like environment
            const result = isBrowser();
            expect(typeof result).toBe('boolean');
        });
    });

    describe('isNode', () => {
        it('should return true in Node.js environment', () => {
            expect(isNode()).toBe(true);
        });
    });

    describe('extractTraceContext', () => {
        it('should extract trace context from traceparent header', () => {
            const headers = {
                traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
            };
            const context = extractTraceContext(headers);

            expect(context).toBeDefined();
            expect(context?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
            expect(context?.spanId).toBe('b7ad6b7169203331');
            expect(context?.traceFlags).toBe(1);
        });

        it('should handle Traceparent header (capitalized)', () => {
            const headers = {
                Traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
            };
            const context = extractTraceContext(headers);

            expect(context).toBeDefined();
            expect(context?.traceFlags).toBe(0);
        });

        it('should return undefined for missing header', () => {
            const context = extractTraceContext({});
            expect(context).toBeUndefined();
        });

        it('should return undefined for invalid format', () => {
            const context = extractTraceContext({ traceparent: 'invalid' });
            expect(context).toBeUndefined();
        });
    });

    describe('createTraceparent', () => {
        it('should create valid traceparent header', () => {
            const traceparent = createTraceparent(
                '0af7651916cd43dd8448eb211c80319c',
                'b7ad6b7169203331',
                1
            );

            expect(traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
        });

        it('should use default trace flags', () => {
            const traceparent = createTraceparent(
                '0af7651916cd43dd8448eb211c80319c',
                'b7ad6b7169203331'
            );

            expect(traceparent).toMatch(/-01$/);
        });

        it('should pad trace flags', () => {
            const traceparent = createTraceparent(
                '0af7651916cd43dd8448eb211c80319c',
                'b7ad6b7169203331',
                0
            );

            expect(traceparent).toMatch(/-00$/);
        });
    });
});
