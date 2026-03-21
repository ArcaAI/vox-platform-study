import { convertPropsToObject } from './convertPropsToObject';
import { describe, it, expect, vi } from 'vitest';

describe('convertPropsToObject', () => {
    it('should return null or undefined as is', () => {
        expect(convertPropsToObject(null)).toBeNull();
        expect(convertPropsToObject(undefined)).toBeUndefined();
    });

    it('should convert Date objects to ISO strings', () => {
        const date = new Date('2023-07-29T12:00:00Z');
        expect(convertPropsToObject(date)).toBe(date.toISOString());
    });

    it('should convert arrays recursively', () => {
        const arr = [1, 'test', new Date('2023-07-29T12:00:00Z')];
        const expected = [
            1,
            'test',
            new Date('2023-07-29T12:00:00Z').toISOString(),
        ];
        expect(convertPropsToObject(arr)).toEqual(expected);
    });

    it('should handle nested objects', () => {
        const obj = {
            name: 'Test',
            details: {
                newDate: new Date('2023-07-29T12:00:00Z'),
                tags: ['2 storeys', '3 storeys'],
            },
        };
        const expected = {
            name: 'Test',
            details: {
                newDate: new Date('2023-07-29T12:00:00Z').toISOString(),
                tags: ['2 storeys', '3 storeys'],
            },
        };
        expect(convertPropsToObject(obj)).toEqual(expected);
    });

    it('should handle objects with toObject method', () => {
        const valueObject = {
            toObject: vi.fn().mockReturnValue({ test: 'testing' }),
        };
        expect(convertPropsToObject(valueObject)).toEqual({ test: 'testing' });
        expect(valueObject.toObject).toHaveBeenCalled();
    });

    it('should handle nested structures with various types', () => {
        const complexObject = {
            id: 1,
            name: 'Complex',
            date: new Date('2023-07-29T12:00:00Z'),
            nested: {
                array: [new Date('2023-07-29T12:00:00Z'), { value: 42 }],
                obj: {
                    valueObject: {
                        toObject: vi
                            .fn()
                            .mockReturnValue({ nestedTest: 'nestedTesting' }),
                    },
                },
            },
        };
        const expected = {
            id: 1,
            name: 'Complex',
            date: new Date('2023-07-29T12:00:00Z').toISOString(),
            nested: {
                array: [
                    new Date('2023-07-29T12:00:00Z').toISOString(),
                    { value: 42 },
                ],
                obj: {
                    valueObject: { nestedTest: 'nestedTesting' },
                },
            },
        };
        expect(convertPropsToObject(complexObject)).toEqual(expected);
    });

    it('should return primitives as is', () => {
        expect(convertPropsToObject(42)).toBe(42);
        expect(convertPropsToObject('test')).toBe('test');
        expect(convertPropsToObject(true)).toBe(true);
    });
});
