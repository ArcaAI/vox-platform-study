import { describe, expect, it } from 'vitest';
import type { PromptTemplate } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import { DEFAULT_AGENT_SLOTS, resolveSlotAssignments, slotAssignInput, slotConfigKey } from '../slot-config';

const prompt = (id: string): PromptTemplate => ({
    id,
    name: `Prompt ${id}`,
    category: 'SUMMARY',
    status: 'PUBLISHED',
    content: '',
    tags: [],
    currentVersionNumber: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
});

const department = (over: Record<string, unknown> = {}): Department =>
    ({ id: 'dept-1', name: 'Cardiology', ...over }) as unknown as Department;

describe('slot-config — default-agent slots ↔ Department prompt-config mapper', () => {
    describe('DEFAULT_AGENT_SLOTS', () => {
        it('declares the 4 slots in display order: 3 summary slots (assign-department field) + DNA-style (prompt-config field)', () => {
            expect(DEFAULT_AGENT_SLOTS.map((s) => s.key)).toEqual(['preSummary', 'newVisit', 'revisit', 'dnaStyle']);
            expect(DEFAULT_AGENT_SLOTS.find((s) => s.key === 'preSummary')?.field).toBe('preSummaryPromptId');
            expect(DEFAULT_AGENT_SLOTS.find((s) => s.key === 'newVisit')?.field).toBe('newPatientPromptId');
            expect(DEFAULT_AGENT_SLOTS.find((s) => s.key === 'revisit')?.field).toBe('revisitPromptId');
            const dna = DEFAULT_AGENT_SLOTS.find((s) => s.key === 'dnaStyle');
            // TASK-387 #7 — DNA writing-style is now backed; it wires via prompt-config, not assign-department.
            expect(dna?.field).toBeUndefined();
            expect(dna?.promptConfigField).toBe('dnaWritingStylePromptId');
            expect(dna?.target).toBeUndefined();
        });
    });

    describe('resolveSlotAssignments', () => {
        it('resolves each REAL slot to its wired PromptTemplate by id', () => {
            const dept = department({ preSummaryPromptId: 'p1', newPatientPromptId: 'p2', revisitPromptId: 'p3' });
            const result = resolveSlotAssignments(dept, [prompt('p1'), prompt('p2'), prompt('p3')]);
            expect(result.find((r) => r.slot.key === 'preSummary')?.prompt?.id).toBe('p1');
            expect(result.find((r) => r.slot.key === 'newVisit')?.prompt?.id).toBe('p2');
            expect(result.find((r) => r.slot.key === 'revisit')?.prompt?.id).toBe('p3');
        });

        it('resolves the DNA-style slot from Department.dnaWritingStylePromptId (TASK-387 #7)', () => {
            const dept = department({ dnaWritingStylePromptId: 'p9' });
            const dna = resolveSlotAssignments(dept, [prompt('p9')]).find((r) => r.slot.key === 'dnaStyle');
            expect(dna?.promptId).toBe('p9');
            expect(dna?.prompt?.id).toBe('p9');
        });

        it('returns null prompt when a slot is unassigned', () => {
            const presummary = resolveSlotAssignments(department(), []).find((r) => r.slot.key === 'preSummary');
            expect(presummary?.promptId).toBeNull();
            expect(presummary?.prompt).toBeNull();
        });

        it('keeps the id but null prompt when the wired prompt is missing from the list', () => {
            const dept = department({ newPatientPromptId: 'ghost' });
            const slot = resolveSlotAssignments(dept, [prompt('other')]).find((r) => r.slot.key === 'newVisit');
            expect(slot?.promptId).toBe('ghost');
            expect(slot?.prompt).toBeNull();
        });
    });

    describe('slotAssignInput', () => {
        it('builds an AssignDepartmentPromptInput (incl. the OCC expectedVersion) for a REAL slot', () => {
            const slot = DEFAULT_AGENT_SLOTS.find((s) => s.key === 'revisit')!;
            expect(slotAssignInput(slot, 'dept-1', 'p3', 4)).toEqual({
                departmentId: 'dept-1',
                promptTemplateId: 'p3',
                field: 'revisitPromptId',
                expectedVersion: 4,
            });
        });

        it('returns null for the DNA-style slot (no assign-department field — it wires via prompt-config)', () => {
            const slot = DEFAULT_AGENT_SLOTS.find((s) => s.key === 'dnaStyle')!;
            expect(slotAssignInput(slot, 'dept-1', 'p9', 1)).toBeNull();
        });
    });

    describe('slotConfigKey', () => {
        it('returns the assign-department field for a summary slot and the prompt-config field for DNA', () => {
            expect(slotConfigKey(DEFAULT_AGENT_SLOTS.find((s) => s.key === 'preSummary')!)).toBe('preSummaryPromptId');
            expect(slotConfigKey(DEFAULT_AGENT_SLOTS.find((s) => s.key === 'dnaStyle')!)).toBe('dnaWritingStylePromptId');
        });
    });
});
