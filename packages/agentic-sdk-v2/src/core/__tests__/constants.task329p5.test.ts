/**
 * Constants Tests — TASK-329 P5 (DNA playground completeness)
 *
 * New owner-scoped DNA endpoints:
 *  - SET_DEFAULT(reportId) — PATCH promote a report to the doctor's default
 *  - MINE                  — GET the doctor's own report history
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { DNA_STYLE_ENDPOINTS } from '../constants';

describe('TASK-329 P5 — DNA_STYLE_ENDPOINTS additions', () => {
    it('SET_DEFAULT should build the owner-scoped default path', () => {
        expect(typeof DNA_STYLE_ENDPOINTS.SET_DEFAULT).toBe('function');
        expect(DNA_STYLE_ENDPOINTS.SET_DEFAULT('report-1')).toBe('/dna-writing-styles/report-1/default');
    });

    it('SET_DEFAULT should encode the report id', () => {
        expect(DNA_STYLE_ENDPOINTS.SET_DEFAULT('a/b')).toBe('/dna-writing-styles/a%2Fb/default');
    });

    it('MINE should point to the owner-scoped report list', () => {
        expect(DNA_STYLE_ENDPOINTS.MINE).toBe('/dna-writing-styles/mine');
    });
});
