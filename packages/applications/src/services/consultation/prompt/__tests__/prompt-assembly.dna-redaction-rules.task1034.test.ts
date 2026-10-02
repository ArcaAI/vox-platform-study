/**
 * TASK-1034 R3 — the harness gateway lane renders the doctor's redaction rules as INSTRUCTIONS
 * (`dna_redaction_rules_text`) beside the writing style. The caller decides the gate; assembly
 * only renders what it is given, and renders nothing when it is given nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };
const mockSchemaRepository = { findByTenantAndSlug: vi.fn() };
const mockSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };

const LEGACY_NAMES = [
  'conversation_language',
  'ner_entities',
  'clinician_notes',
  'attachments',
  'doctor_highlights',
  'current_department',
  'visit_type',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'formatted_test_results',
  'formatted_previous_visits',
  'language_name',
  'pre_summary_text',
  'prior_visit_summary',
  'dna_style_text',
  'dna_redaction_rules_text',
];

const legacyDefinition = () => ({
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'context',
      label: 'Legacy Prompt Context',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'ANY',
      producedBy: ['SYSTEM'],
      fields: { type: 'object', properties: Object.fromEntries(LEGACY_NAMES.map((n) => [n, { type: 'string' }])) },
    },
  ],
});

async function getService(withClone = true) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  if (withClone) {
    mockSchemaRepository.findByTenantAndSlug.mockResolvedValue({ id: 'schema-1', tenantId: 'tenant-1', pinnedVersionNumber: 1 });
    mockSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({ id: 'v1', versionNumber: 1, definition: legacyDefinition() });
  } else {
    mockSchemaRepository.findByTenantAndSlug.mockResolvedValue(null);
  }
  return new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    undefined,
    undefined,
    undefined,
    undefined,
    mockDepartmentRepository as never,
    mockSchemaRepository as never,
    mockSchemaVersionRepository as never,
  );
}

const params = () => ({
  tenantId: 'tenant-1',
  departmentId: 'dept-1',
  promptType: 'pre-summary' as const,
  transcript: 'case notes',
  conversationLanguage: 'en',
  visitType: 'revisit',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'template-presummary', metaData: null });
  mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', name: 'Cardiology' });
});

function resolvesTo(content: string): void {
  mockPromptResolutionService.resolve.mockResolvedValue({
    template: 'Final',
    promptId: 'template-presummary',
    content,
    resolvedFrom: 'tenant',
    resolutionTrace: { usedDefaults: [] },
  });
}

const RULES_TEXT = '- Never write "Ms. Ada Byron".\n- Always write "pt" as "patient".';

describe('TASK-1034 R3 — `dna_redaction_rules_text` in the gateway-assembled prompt', () => {
  it('appends the rules under their own heading when the template has no slot for them', async () => {
    resolvesTo('Write the note.');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: RULES_TEXT });
    expect(userPrompt).toContain('--- CLINICIAN REDACTION RULES (never include / always rewrite) ---\n' + RULES_TEXT);
  });

  it('a template that binds `{{context.dna_redaction_rules_text}}` renders it ONCE, in place', async () => {
    resolvesTo('Rules:\n{{context.dna_redaction_rules_text}}');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: RULES_TEXT });
    expect(userPrompt.startsWith('Rules:\n' + RULES_TEXT)).toBe(true);
    expect(userPrompt).not.toContain('CLINICIAN REDACTION RULES');
  });

  it.each([[undefined], ['']])('renders nothing for %j — the gate is off or the doctor authored no rules', async (text) => {
    resolvesTo('Rules: [{{context.dna_redaction_rules_text}}]');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: text });
    expect(userPrompt.startsWith('Rules: []')).toBe(true);
    expect(userPrompt).not.toContain('CLINICIAN REDACTION RULES');
  });
});
