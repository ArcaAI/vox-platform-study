/**
 * Constants Tests — Workstream H additions
 *
 * Tests for new endpoint constants added in WS-H.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
    CONSULTATION_ENDPOINTS,
    DNA_STYLE_ENDPOINTS,
} from '../constants';

describe('WS-H Constants', () => {
    describe('CONSULTATION_ENDPOINTS.LIST', () => {
        it('should be defined as a string', () => {
            expect(CONSULTATION_ENDPOINTS.LIST).toBeDefined();
            expect(typeof CONSULTATION_ENDPOINTS.LIST).toBe('string');
        });

        it('should point to /consultations', () => {
            expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
        });
    });

    describe('DNA_STYLE_ENDPOINTS.BY_DOCTOR', () => {
        it('should be defined as a function', () => {
            expect(DNA_STYLE_ENDPOINTS.BY_DOCTOR).toBeDefined();
            expect(typeof DNA_STYLE_ENDPOINTS.BY_DOCTOR).toBe('function');
        });

        it('should return correct path', () => {
            expect(DNA_STYLE_ENDPOINTS.BY_DOCTOR('doc-123')).toBe('/dna-writing-styles/doctor/doc-123');
        });
    });

    describe('CONSULTATION_ENDPOINTS completeness', () => {
        it('should have all expected keys including LIST', () => {
            const keys = Object.keys(CONSULTATION_ENDPOINTS);
            expect(keys).toEqual(
                expect.arrayContaining([
                    'OPEN', 'GET', 'PATIENT_HISTORY', 'PATIENT_DATE',
                    'TIMELINE', 'CHAIN', 'LIST',
                ])
            );
        });
    });

    describe('DNA_STYLE_ENDPOINTS completeness', () => {
        it('should have all expected keys including BY_DOCTOR', () => {
            const keys = Object.keys(DNA_STYLE_ENDPOINTS);
            expect(keys).toEqual(
                expect.arrayContaining([
                    'GENERATE', 'GENERATE_FOR_DOCTOR', 'MY_STYLE',
                    'UPDATE', 'VERSIONS', 'ADMIN_LIST',
                    'ADMIN_JOB_STATUS', 'BY_DOCTOR',
                ])
            );
        });
    });
});
