import { describe, expect, it } from 'vitest';
import { isOccConflict, reduceOccConflict } from '../occ';

describe('OCC conflict reducer (optimistic-concurrency 409/412 handling)', () => {
    describe('isOccConflict', () => {
        it('detects a 409 Conflict', () => {
            expect(isOccConflict({ status: 409 })).toBe(true);
        });
        it('detects a 412 Precondition Failed', () => {
            expect(isOccConflict({ status: 412 })).toBe(true);
        });
        it('detects a statusCode-shaped error (Nest/Agentic style)', () => {
            expect(isOccConflict({ statusCode: 409 })).toBe(true);
        });
        it('detects an AgenticError whose HTTP status lives under context (412)', () => {
            // The SDK throws `new AgenticError(code, msg, { context: { status } })`,
            // so the status is nested — the reducer must look there too.
            expect(isOccConflict({ code: 'API_ERROR', context: { status: 412 } })).toBe(true);
            expect(isOccConflict({ context: { statusCode: 409 } })).toBe(true);
        });
        it('is false for other errors / non-errors', () => {
            expect(isOccConflict({ status: 500 })).toBe(false);
            expect(isOccConflict({ context: { status: 500 } })).toBe(false);
            expect(isOccConflict(new Error('boom'))).toBe(false);
            expect(isOccConflict(null)).toBe(false);
            expect(isOccConflict(undefined)).toBe(false);
        });
    });

    describe('reduceOccConflict', () => {
        it('returns a conflict resolution with a refetch-and-retry message for a 409', () => {
            const res = reduceOccConflict({ status: 409 });
            expect(res.conflict).toBe(true);
            expect(res.message).toMatch(/changed since/i);
        });

        it('passes other errors through as non-conflicts', () => {
            expect(reduceOccConflict({ status: 500 })).toEqual({ conflict: false });
        });
    });
});
