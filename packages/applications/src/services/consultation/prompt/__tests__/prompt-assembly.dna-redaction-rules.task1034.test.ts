/**
 * TASK-1034 R3 — the harness gateway lane renders the doctor's redaction rules as INSTRUCTIONS
 * (`dna_redaction_rules_text`) beside the writing style. The caller decides the gate; assembly
 * only renders what it is given, and renders nothing when it is given nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastBlockAliases, lastComposeInput, lastScopeContext, lastSystemSide } from './compose-spy';

vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, composeMessages: vi.fn(actual.composeMessages) };
});

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
  // TASK-1047 D1 — the doctor's rules are a per-doctor RUNTIME value: DATA in the STYLE REFERENCE
  // section; the system message carries only the static instruction about applying them.
  it('carries the rules as DATA under their own heading in STYLE REFERENCE, with a static instruction in the system message', async () => {
    resolvesTo('Write the note.');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: RULES_TEXT });
    expect(userPrompt).toContain('<<<EXTERNAL_DATA section="style_reference">>>');
    expect(userPrompt).toContain('--- CLINICIAN REDACTION RULES (never include / always rewrite) ---\n' + RULES_TEXT);
    expect(lastSystemSide()).not.toContain(RULES_TEXT);
    expect((lastComposeInput().outputContractParts ?? []).map((part) => part.key)).toEqual(['dna-redaction-rules']);
  });

  it('a template that binds `{{context.dna_redaction_rules_text}}` points at STYLE REFERENCE — the rules appear ONCE', async () => {
    resolvesTo('Rules:\n{{context.dna_redaction_rules_text}}');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: RULES_TEXT });
    expect(lastBlockAliases()['context.dna_redaction_rules_text']).toBe('style_reference');
    expect(userPrompt.split(RULES_TEXT).length - 1).toBe(1);
    expect(lastComposeInput().outputContractParts ?? []).toEqual([]);
  });

  it.each([[undefined], ['']])('renders nothing for %j — the gate is off or the doctor authored no rules', async (text) => {
    resolvesTo('Rules: [{{context.dna_redaction_rules_text}}]');
    const { userPrompt } = await (await getService()).assemble({ ...params(), dnaRedactionRulesText: text });
    expect(lastScopeContext().dna_redaction_rules_text).toBe('');
    expect(lastBlockAliases()).not.toHaveProperty('context.dna_redaction_rules_text');
    expect(userPrompt).not.toContain('style_reference');
    expect(lastSystemSide()).not.toContain('REDACTION RULES');
  });
});
