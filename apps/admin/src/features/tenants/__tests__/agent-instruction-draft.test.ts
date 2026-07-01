import { describe, expect, it } from 'vitest';
import { serviceToCategory, toCreatePromptInput } from '../agent-instruction-draft';

describe('agent-instruction draft → CreatePromptInput (scope/category derivation)', () => {
    describe('serviceToCategory', () => {
        it('maps Summarization → SUMMARY', () => {
            expect(serviceToCategory('SUMMARIZATION')).toBe('SUMMARY');
        });
        it('maps DNA → DNA_ANALYSIS', () => {
            expect(serviceToCategory('DNA')).toBe('DNA_ANALYSIS');
        });
        it('maps everything else → CUSTOM', () => {
            expect(serviceToCategory('GUARDRAIL')).toBe('CUSTOM');
            expect(serviceToCategory('NLP')).toBe('CUSTOM');
        });
    });

    describe('toCreatePromptInput', () => {
        it('scopes the instruction to the department (DEPARTMENT_DEFAULT) and derives the category', () => {
            const input = toCreatePromptInput(
                { name: '  Cardiology Intake Summary  ', service: 'SUMMARIZATION', content: '  You are a clinical assistant.  ' },
                'dept-1',
            );
            expect(input).toEqual({
                name: 'Cardiology Intake Summary',
                content: 'You are a clinical assistant.',
                category: 'SUMMARY',
                departmentId: 'dept-1',
                status: 'PUBLISHED',
            });
        });

        it('derives CUSTOM for non-summary/DNA services', () => {
            expect(toCreatePromptInput({ name: 'Guard', service: 'GUARDRAIL', content: 'x' }, 'dept-2').category).toBe('CUSTOM');
        });
    });
});
