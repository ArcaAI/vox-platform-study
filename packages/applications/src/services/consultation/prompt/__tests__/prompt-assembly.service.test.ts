/**
 * PromptAssemblyService Unit Tests (TDD — RED first)
 *
 * Tests the prompt assembly pipeline:
 * 1. Resolve template by department + visit type
 * 2. Load template content + hyperparameters + JSON schema
 * 3. Substitute variables
 * 4. Build SMR payload with all parameters
 *
 * Coverage: E2 (Prompt Assembly & Variable Substitution)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockPromptResolutionService = {
    resolve: vi.fn(),
};

const mockPromptTemplateRepository = {
    findById: vi.fn(),
};

const mockDnaWritingStyleRepository = {
    findById: vi.fn(),
};

function createMockPromptTemplate(overrides: Partial<{
    id: string;
    name: string;
    content: string;
    variables: Record<string, unknown>;
    metaData: Record<string, unknown>;
}> = {}) {
    return {
        id: overrides.id ?? 'template-001',
        name: overrides.name ?? 'Surgery-NewReferral',
        content: overrides.content ?? 'Summarize for {conversation_language}. Style: {style_DNA_doctor_department_surgery}.',
        variables: overrides.variables ?? {
            conversation_language: { type: 'string', required: true },
            style_DNA_doctor_department_surgery: { type: 'string', required: false },
        },
        metaData: overrides.metaData ?? {
            promptConfig: {
                hyperparameters: { temperature: 0.1, max_tokens: 6000, top_p: 0.95 },
                outputSchema: {
                    type: 'object',
                    properties: { subjective: { type: 'string' }, objective: { type: 'string' } },
                    required: ['subjective', 'objective'],
                    title: 'SurgeryNote',
                },
            },
        },
    };
}

function createMockDnaStyle(overrides: Partial<{
    id: string;
    styleText: string;
}> = {}) {
    return {
        id: overrides.id ?? 'dna-001',
        styleText: overrides.styleText ?? 'Use bullet points. Be concise.',
    };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('PromptAssemblyService', () => {
    let service: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockPromptResolutionService.resolve.mockResolvedValue({
            template: 'Surgery-NewReferral',
            promptId: 'template-001',
            contextVariables: {},
            resolvedFrom: 'department',
            resolutionTrace: { usedDefaults: [] },
        });

        mockPromptTemplateRepository.findById.mockResolvedValue(createMockPromptTemplate());
        mockDnaWritingStyleRepository.findById.mockResolvedValue(createMockDnaStyle());
    });

    // TASK-355 Phase C (R-6) — warm-start is gated behind HARNESS_WARM_START_ENABLED
    // (default OFF). Construct with a ConfigService mock; pass `true` to enable.
    async function getService(warmStartEnabled = false) {
        const { PromptAssemblyService } = await import('../prompt-assembly.service');
        const configService = {
            get: vi.fn((key: string) =>
                key === 'HARNESS_WARM_START_ENABLED' ? (warmStartEnabled ? 'true' : undefined) : undefined,
            ),
        };
        return new PromptAssemblyService(
            mockPromptResolutionService as any,
            mockPromptTemplateRepository as any,
            mockDnaWritingStyleRepository as any,
            configService as any,
        );
    }

    // ── Module existence ──

    it('should be importable', async () => {
        const { PromptAssemblyService } = await import('../prompt-assembly.service');
        expect(PromptAssemblyService).toBeDefined();
    });

    // ── Core assembly ──

    describe('assemble()', () => {
        it('should resolve prompt template and return assembled payload', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents with knee pain...',
                conversationLanguage: 'English',
            });

            expect(result).toBeDefined();
            expect(result.userPrompt).toBeDefined();
            expect(result.systemPrompt).toBeDefined();
            expect(result.hyperparameters).toBeDefined();
        });

        it('should substitute {conversation_language} in template content', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'French',
            });

            expect(result.userPrompt).toContain('French');
            expect(result.userPrompt).not.toContain('{conversation_language}');
        });

        it('should substitute {style_DNA_*} when dnaStyleId is provided', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'English',
                dnaStyleId: 'dna-001',
            });

            expect(result.userPrompt).toContain('Use bullet points. Be concise.');
            expect(result.userPrompt).not.toContain('{style_DNA_doctor_department_surgery}');
        });

        it('should load hyperparameters from template metaData.promptConfig', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'English',
            });

            expect(result.hyperparameters.temperature).toBe(0.1);
            expect(result.hyperparameters.max_tokens).toBe(6000);
            expect(result.hyperparameters.top_p).toBe(0.95);
        });

        it('should include outputSchema when template has one', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'English',
            });

            expect(result.responseFormat).toBeDefined();
            expect(result.responseFormat.type).toBe('json_schema');
            expect(result.responseFormat.json_schema.title).toBe('SurgeryNote');
        });

        it('should set responseFormat to null when template has no outputSchema', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({
                    metaData: { promptConfig: { hyperparameters: { temperature: 0.1 } } },
                }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'English',
            });

            expect(result.responseFormat).toBeNull();
        });

        it('should append transcript to the user prompt', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient complains of headache',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).toContain('Patient complains of headache');
        });
    });

    // ── Edge cases ──

    describe('edge cases', () => {
        it('should use default hyperparameters when template has no promptConfig', async () => {
            mockPromptTemplateRepository.findById.mockReset();
            mockPromptTemplateRepository.findById.mockResolvedValue({
                id: 'template-no-config',
                name: 'Basic',
                content: 'Simple template for {conversation_language}.',
                variables: {},
                metaData: null,
            });
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
            });

            expect(result.hyperparameters).toEqual({});
        });

        it('should handle missing template gracefully with fallback', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(null);
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient presents...',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).toContain('Patient presents...');
            expect(result.hyperparameters).toEqual({});
        });

        it('should handle missing dnaStyleId gracefully', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).toBeDefined();
            expect(mockDnaWritingStyleRepository.findById).not.toHaveBeenCalled();
        });

        it('should handle dnaStyleId when style not found in DB', async () => {
            mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
                dnaStyleId: 'nonexistent',
            });

            expect(result.userPrompt).toBeDefined();
        });

        it('should include preSummaryText when provided', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({
                    content: 'Template with {pre_summary_text}. Language: {conversation_language}.',
                }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
                preSummaryText: 'Previous notes: HbA1c 7.2%',
            });

            expect(result.userPrompt).toContain('Previous notes: HbA1c 7.2%');
            expect(result.userPrompt).not.toContain('{pre_summary_text}');
        });

        it('should include sameDayPrequelSummary when provided', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({
                    content: 'Template with {same_day_prequel_summary}. Language: {conversation_language}.',
                }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
                sameDayPrequelSummary: 'Earlier visit: vitals stable',
            });

            expect(result.userPrompt).toContain('Earlier visit: vitals stable');
        });
    });

    // ── Return shape ──

    describe('return shape', () => {
        it('should return all required fields', async () => {
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'test',
                conversationLanguage: 'English',
            });

            expect(result).toHaveProperty('userPrompt');
            expect(result).toHaveProperty('systemPrompt');
            expect(result).toHaveProperty('hyperparameters');
            expect(result).toHaveProperty('responseFormat');
            expect(result).toHaveProperty('resolvedFrom');
        });
    });

    // ── NER → prompt injection (TASK-330 Phase 1) ──
    // Closes the gap where NER output is computed but never reaches the LLM.

    describe('NER injection (TASK-330 Phase 1)', () => {
        it('appends recognized clinical entities (text + codes) when the template has no {ner_entities} placeholder', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient on amoxicillin for pneumonia.',
                conversationLanguage: 'English',
                nerEntities: [
                    { text: 'amoxicillin', type: 'MEDICATION', rxnormCode: '723', startOffset: 11, endOffset: 22 },
                    { text: 'pneumonia', type: 'CONDITION', icdCode: 'J18.9' },
                ],
            });

            expect(result.userPrompt).toContain('RECOGNIZED CLINICAL ENTITIES');
            expect(result.userPrompt).toContain('amoxicillin');
            expect(result.userPrompt).toContain('MEDICATION');
            expect(result.userPrompt).toContain('rxnorm:723');
            expect(result.userPrompt).toContain('icd:J18.9');
            expect(result.userPrompt).toContain('@11-22');
        });

        it('substitutes the {ner_entities} placeholder in template content (no duplicate appended block)', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({
                    content: 'Known entities: {ner_entities}. Language: {conversation_language}.',
                }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient has pneumonia.',
                conversationLanguage: 'English',
                nerEntities: [{ text: 'pneumonia', type: 'CONDITION', icdCode: 'J18.9' }],
            });

            expect(result.userPrompt).toContain('pneumonia');
            expect(result.userPrompt).toContain('icd:J18.9');
            expect(result.userPrompt).not.toContain('{ner_entities}');
            // Block was consumed by the placeholder → no second "RECOGNIZED" section.
            expect(result.userPrompt).not.toContain('RECOGNIZED CLINICAL ENTITIES');
        });

        it('prefers normalizedText for the entity label when present', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Pt c/o HA.',
                conversationLanguage: 'English',
                nerEntities: [{ text: 'HA', type: 'SYMPTOM', normalizedText: 'headache', snomedCode: '25064002' }],
            });

            expect(result.userPrompt).toContain('headache');
            expect(result.userPrompt).toContain('snomed:25064002');
        });

        it('does not add a NER section when no entities are provided', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'No entities here.',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).not.toContain('RECOGNIZED CLINICAL ENTITIES');
        });

        // TASK-462 C5-03 — the ontology code columns (umls/snomed/rxnorm/icd/loinc)
        // are READ here but WRITTEN nowhere until the SOTA Theme C clinical NER
        // linker lands (TASK-476), so today the code set is ALWAYS empty. The
        // groundedness guard makes that absence EXPLICIT instead of silently
        // emitting un-coded entity lines that read as if coding was attempted.
        it('flags the absence of ontology codes when NER entities carry none (C5-03 groundedness guard)', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient reports headache and fever.',
                conversationLanguage: 'English',
                nerEntities: [
                    { text: 'headache', type: 'SYMPTOM', startOffset: 16, endOffset: 24 },
                    { text: 'fever', type: 'SYMPTOM' },
                ],
            });

            // Entities still reach the LLM (text + type), but the absence of codes is EXPLICIT.
            expect(result.userPrompt).toContain('RECOGNIZED CLINICAL ENTITIES');
            expect(result.userPrompt).toContain('headache');
            expect(result.userPrompt).toContain('no clinical ontology codes present');
            // No misleading empty coded output: no bare bracket, no dangling code tokens.
            expect(result.userPrompt).not.toContain('[]');
            expect(result.userPrompt).not.toContain('umls:');
        });

        it('does NOT flag the absence when at least one ontology code is present (guard disengaged)', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient has pneumonia.',
                conversationLanguage: 'English',
                nerEntities: [
                    { text: 'headache', type: 'SYMPTOM' },
                    { text: 'pneumonia', type: 'CONDITION', icdCode: 'J18.9' },
                ],
            });

            expect(result.userPrompt).toContain('icd:J18.9');
            expect(result.userPrompt).not.toContain('no clinical ontology codes present');
        });
    });

    // ── Clinician notes + attachments injection (TASK-342 GAP #2) ──
    describe('clinician notes + attachments injection (TASK-342 GAP #2)', () => {
        it('appends clinician notes and attachments blocks when the template has no placeholders', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
                clinicianNotes: [
                    '[case note] Patient anxious about results',
                    '[work note] Order troponin',
                ],
                attachments: ['Troponin 0.9 ng/mL (elevated)'],
            });

            expect(result.userPrompt).toContain('CLINICIAN NOTES');
            expect(result.userPrompt).toContain('Patient anxious about results');
            expect(result.userPrompt).toContain('Order troponin');
            expect(result.userPrompt).toContain('ATTACHMENTS');
            expect(result.userPrompt).toContain('Troponin 0.9 ng/mL (elevated)');
        });

        it('substitutes {clinician_notes} and {attachments} placeholders without duplicating blocks', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({
                    content:
                        'Notes: {clinician_notes}\nAttachments: {attachments}\nLang: {conversation_language}.',
                }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Visit transcript.',
                conversationLanguage: 'English',
                clinicianNotes: ['[case note] Follow up in 2 weeks'],
                attachments: ['CBC within normal limits'],
            });

            expect(result.userPrompt).toContain('Follow up in 2 weeks');
            expect(result.userPrompt).toContain('CBC within normal limits');
            expect(result.userPrompt).not.toContain('{clinician_notes}');
            expect(result.userPrompt).not.toContain('{attachments}');
            // Consumed by placeholders → no duplicated appended sections.
            expect(result.userPrompt).not.toContain('--- CLINICIAN NOTES');
            expect(result.userPrompt).not.toContain('--- ATTACHMENTS');
        });

        it('does not add clinician notes / attachments sections when none are provided', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).not.toContain('CLINICIAN NOTES');
            expect(result.userPrompt).not.toContain('ATTACHMENTS');
        });
    });

    // ── Doctor highlights injection (TASK-344 Workstream B) ──
    describe('doctor highlights injection (TASK-344 Workstream B)', () => {
        it('appends a doctor highlights block when the template has no placeholder', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient reports chest pain radiating to the left arm.',
                conversationLanguage: 'English',
                highlights: ['[highlight] chest pain', '[highlight] radiating to the left arm'],
            });

            expect(result.userPrompt).toContain('DOCTOR HIGHLIGHTS');
            expect(result.userPrompt).toContain('chest pain');
            expect(result.userPrompt).toContain('radiating to the left arm');
        });

        it('substitutes the {doctor_highlights} placeholder without duplicating the block', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Highlights: {doctor_highlights}\nLang: {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Visit transcript.',
                conversationLanguage: 'English',
                highlights: ['[highlight] severe cough'],
            });

            expect(result.userPrompt).toContain('severe cough');
            expect(result.userPrompt).not.toContain('{doctor_highlights}');
            expect(result.userPrompt).not.toContain('--- DOCTOR HIGHLIGHTS');
        });

        it('adds no highlights section when none are provided', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService();
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).not.toContain('DOCTOR HIGHLIGHTS');
        });
    });

    // ── Pre-summary warm-start injection (TASK-355 Phase C — R-6) ──
    // The harness warm-starts `generate` from the live SOAP snapshot. Mirrors
    // the NER / notes / highlights fallback: the seed templates DECLARE
    // {pre_summary_text} in their variables map but never INLINE the placeholder
    // in content, so without an append-fallback the snapshot would silently never
    // reach the LLM (the latent no-op the legacy path also suffered).
    describe('pre-summary warm-start injection (TASK-355 Phase C R-6)', () => {
        it('appends the prior-draft block + refinement instruction when the template has no {pre_summary_text} placeholder', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService(true); // warm-start ON
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
                preSummaryText: 'S: chest pain O: BP 120/80 A: stable P: review',
            });

            // Proves the latent no-op is fixed: the snapshot text reaches the prompt …
            expect(result.userPrompt).toContain('S: chest pain O: BP 120/80 A: stable P: review');
            // … under a refinement-instruction header that keeps the transcript authoritative.
            expect(result.userPrompt).toContain('PRIOR DRAFT');
            expect(result.userPrompt).toContain('Refine');
            expect(result.userPrompt).toContain('source of truth');
        });

        it('substitutes {pre_summary_text} without duplicating the prior-draft block', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Prior: {pre_summary_text}. Lang: {conversation_language}.' }),
            );
            service = await getService(true); // warm-start ON
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'revisit',
                transcript: 'Visit transcript.',
                conversationLanguage: 'English',
                preSummaryText: 'S: running soap draft',
            });

            expect(result.userPrompt).toContain('S: running soap draft');
            expect(result.userPrompt).not.toContain('{pre_summary_text}');
            // Consumed by the placeholder → no duplicated appended section.
            expect(result.userPrompt).not.toContain('--- PRIOR DRAFT');
        });

        it('adds no prior-draft section when preSummaryText is absent (cold path unchanged)', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService(true); // warm-start ON
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
            });

            expect(result.userPrompt).not.toContain('PRIOR DRAFT');
        });

        // ── Kill-switch OFF (default) — the load-bearing legacy gate ──
        it('does NOT append the prior-draft block when the flag is OFF (default), even with pre_summary_text present', async () => {
            mockPromptTemplateRepository.findById.mockResolvedValue(
                createMockPromptTemplate({ content: 'Summarize for {conversation_language}.' }),
            );
            service = await getService(); // flag OFF (prod default)
            const result = await service.assemble({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                transcript: 'Patient reports chest pain.',
                conversationLanguage: 'English',
                preSummaryText: 'S: chest pain O: BP 120/80 A: stable P: review',
            });

            // Prod default == pre-Phase-C: the append-fallback is neutralized, so
            // neither the harness nor the legacy SummaryService path injects it.
            expect(result.userPrompt).not.toContain('PRIOR DRAFT');
            expect(result.userPrompt).not.toContain('S: chest pain O: BP 120/80 A: stable P: review');
        });
    });
});
