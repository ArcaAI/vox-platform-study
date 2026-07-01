import { describe, expect, it } from 'vitest';
import { toCreateDepartmentRequest } from '../department-draft';

describe('toCreateDepartmentRequest (department draft → SDK create payload)', () => {
    it('trims name and code', () => {
        expect(toCreateDepartmentRequest({ name: '  Cardiology  ', code: '  card  ' })).toEqual({
            name: 'Cardiology',
            code: 'card',
        });
    });

    it('omits an empty/whitespace code', () => {
        expect(toCreateDepartmentRequest({ name: 'Neurology', code: '   ' })).toEqual({ name: 'Neurology' });
        expect(toCreateDepartmentRequest({ name: 'Neurology' })).toEqual({ name: 'Neurology' });
    });

    it('includes a non-empty description and omits an empty one', () => {
        expect(toCreateDepartmentRequest({ name: 'Oncology', description: 'Cancer care' })).toEqual({
            name: 'Oncology',
            description: 'Cancer care',
        });
        expect(toCreateDepartmentRequest({ name: 'Oncology', description: '  ' })).toEqual({ name: 'Oncology' });
    });
});
