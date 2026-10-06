/**
 * Assembly carries what the CLIENT sent: vitals, prior visits, and case notes under their own name.
 *
 * ## Two defects, one seam
 *
 * 1. `PromptAssemblyParams` had no way to state vitals or a prior-visit history, so the v1
 *    placeholders `{{context.safe_vitals}}` and `{{context.formatted_previous_visits}}` rendered
 *    `Not available` and `''` on EVERY assembled prompt — for a consultation whose clinic had
 *    measured the readings and sent the notes. The comment beside the builder call said the v2 data
 *    model held no such thing; it has since the client began stating them at `open`.
 * 2. The pre-summary path fed its CASE NOTES in as `transcript`, so the model received historical
 *    notes under `<<<EXTERNAL_DATA section="transcript">>> --- TRANSCRIPT ---` — a label that says
 *    "this is what was said in today's encounter" about text from previous ones.
 *
 * Both are fixed HERE rather than in the templates, so no seeded body is regenerated and a tenant's
 * own template keeps working: the values flow through the SAME `buildPreSummaryVariables` the
 * realtime lane uses, and a body that does not inline them gets an appended, delimiter-wrapped data
 * block — the convention `ner_entities` / `clinician_notes` / `attachments` already follow.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastBlockAliases, lastScopeContext, lastSystemSide } from './compose-spy';

// TASK-1047 — the composer renders the pointers (FC-1); this suite pins which block a slot points
// at and what the scope binds, at the composer's input.
vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, composeMessages: vi.fn(actual.composeMessages) };
});

const V1_PRE_SUMMARY_BODY = [
  '- **Recent Vitals:** {{context.safe_vitals}} (two most recent encounters)',
  '- **Previous Visits:** {{context.formatted_previous_visits}}',
  '- Language: {{context.language_name}}',
].join('\n');

/** A summary body that inlines NOTHING — every block must arrive as an appended data section. */
const PLAIN_SUMMARY_BODY = 'Write the note in {{context.conversation_language}}.';

const VITALS_LINE = 'BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C';
const PREVIOUS_VISITS = '2026-03-02 · Lipid panel follow-up\nPRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };

async function getService() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as any,
    mockPromptTemplateRepository as any,
    mockDnaWritingStyleRepository as any,
    undefined, // cls
    undefined, // exemplarRetriever
    undefined, // secretsService
    mockDepartmentRepository as any,
  );
}

const withBody = (content: string) =>
  mockPromptResolutionService.resolve.mockResolvedValue({
    template: 'body',
    promptId: 'template-1',
    content,
    resolvedFrom: 'tenant',
    resolutionTrace: { usedDefaults: [] },
  });

beforeEach(() => {
  vi.clearAllMocks();
  withBody(V1_PRE_SUMMARY_BODY);
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'template-1', metaData: null });
  mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', name: 'Breast & Endocrine' });
});

describe('the client-supplied vitals reach the prompt', () => {
  it('points the body’s vitals slot at the RECENT VITALS data section, instead of "Not available"', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      vitals: VITALS_LINE,
    });

    expect(lastBlockAliases()['context.safe_vitals']).toBe('recent_vitals');
    expect(lastScopeContext().safe_vitals).toBe(VITALS_LINE);
    expect(userPrompt).toContain('<<<EXTERNAL_DATA section="recent_vitals">>>\n--- RECENT VITALS ---\n' + VITALS_LINE);
  });

  it("keeps v1's own default when the client stated no reading", async () => {
    const service = await getService();

    await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });

    // The slot is bound to v1's own default — which then fills the (otherwise skipped) section.
    expect(lastScopeContext().safe_vitals).toBe('Not available');
  });

  it('appends the readings as a RECENT VITALS data block on a body that inlines nothing', async () => {
    withBody(PLAIN_SUMMARY_BODY);
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'revisit',
      transcript: 'today’s transcript',
      conversationLanguage: 'en',
      vitals: VITALS_LINE,
    });

    expect(userPrompt).toContain('<<<EXTERNAL_DATA section="recent_vitals">>>\n--- RECENT VITALS ---\n' + VITALS_LINE);
  });

  it('appends NO vitals block when the client sent none — the prompt stays byte-identical', async () => {
    withBody(PLAIN_SUMMARY_BODY);
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'revisit',
      transcript: 'today’s transcript',
      conversationLanguage: 'en',
    });

    expect(userPrompt).not.toContain('recent_vitals');
  });

  it('never states the readings twice: the section appears ONCE and the body only points at it', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      vitals: VITALS_LINE,
    });

    expect(userPrompt.split('section="recent_vitals"').length - 1).toBe(1);
    expect(lastBlockAliases()['context.safe_vitals']).toBe('recent_vitals');
    expect(lastSystemSide()).not.toContain(VITALS_LINE);
  });
});

describe('the client-supplied previous visits reach the prompt', () => {
  it('points the body’s history slot at the PREVIOUS CASE NOTES SUMMARY data section', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      previousVisits: PREVIOUS_VISITS,
    });

    expect(lastBlockAliases()['context.formatted_previous_visits']).toBe('previous_case_notes_summary');
    expect(userPrompt).toContain(PREVIOUS_VISITS);
  });

  it('appends it as a PREVIOUS CASE NOTES SUMMARY block on a body that inlines nothing', async () => {
    withBody(PLAIN_SUMMARY_BODY);
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'revisit',
      transcript: 'today’s transcript',
      conversationLanguage: 'en',
      previousVisits: PREVIOUS_VISITS,
    });

    expect(userPrompt).toContain(
      '<<<EXTERNAL_DATA section="previous_case_notes_summary">>>\n--- PREVIOUS CASE NOTES SUMMARY ---\n' + PREVIOUS_VISITS,
    );
  });

  it('never states the history twice', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      previousVisits: PREVIOUS_VISITS,
    });

    expect(userPrompt.split('section="previous_case_notes_summary"').length - 1).toBe(1);
    expect(lastBlockAliases()['context.formatted_previous_visits']).toBe('previous_case_notes_summary');
    expect(lastSystemSide()).not.toContain(PREVIOUS_VISITS);
  });
});

describe('case notes arrive labelled as case notes, not as a transcript', () => {
  it('wraps them under section="case_notes" with the CASE NOTES header', async () => {
    withBody(PLAIN_SUMMARY_BODY);
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: '',
      conversationLanguage: 'en',
      caseNotes: [
        'Hypertension review\nPRIOR-NOTE-ALPHA: controlled on amlodipine 5 mg.',
        'Lipid panel follow-up\nPRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.',
      ],
    });

    expect(userPrompt).toContain('<<<EXTERNAL_DATA section="case_notes">>>\n--- CASE NOTES ---\n');
    expect(userPrompt).toContain('PRIOR-NOTE-ALPHA');
    expect(userPrompt).toContain('PRIOR-NOTE-BRAVO');
    // The label that made historical notes read as today's encounter.
    expect(userPrompt).not.toContain('--- TRANSCRIPT ---');
  });

  it('appends no case-notes block when the caller passed none', async () => {
    withBody(PLAIN_SUMMARY_BODY);
    const service = await getService();

    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'revisit',
      transcript: 'today’s transcript',
      conversationLanguage: 'en',
    });

    expect(userPrompt).not.toContain('section="case_notes"');
    // A real transcript still arrives as one.
    expect(userPrompt).toContain('--- TRANSCRIPT ---');
  });
});
