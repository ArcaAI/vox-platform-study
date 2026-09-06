/**
 * TASK-890 §3.2/§3.4/§3.11 — `PromptAssemblyService` renders through the ONE grammar over the
 * `context.*` namespace declared by the tenant's `consultation_legacy_v1` schema clone.
 *
 * This is the highest-blast-radius half of the ticket: this service assembles the prompt for
 * SIX consultation callers, and until now it carried §2.4 flavour 2 — a second single-brace
 * regex (`{var}`, hyphens allowed) over a hardcoded 5+9+11 NAME list. Two things change and one
 * deliberately does not:
 *
 *  - the RENDERER becomes `renderTemplate`, so `{{context.conversation_language}}` resolves by
 *    dotted traversal and a leftover single brace renders VERBATIM (no fallback pass — an
 *    unconverted template shows its unconverted variable instead of quietly working);
 *  - the NAME list is no longer the contract: the tenant's clone of the SYSTEM bridge schema
 *    declares the vocabulary, and every name it declares that this call did not populate is
 *    bound to the empty string rather than left as a literal in a clinical prompt;
 *  - the VALUE builders are untouched (§3.4), so the assembled bytes are identical.
 *
 * The GOLDEN case is the last one: the legacy single-brace body rendered by the OLD renderer
 * and the converted `{{context.…}}` body rendered by the new one must produce the SAME string.
 *
 * TRANSITION (orchestrator decision, recorded in the lane report): until L13 backfills every
 * tenant with its clone, an ABSENT clone must not fail a live consultation — the code-owned
 * builders still populate `context.*` and the service WARNs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The legacy body as the seeds carry it TODAY (single brace) — the BEFORE side of the golden pair. */
const LEGACY_BODY = [
  '- **Department:** {current_department}',
  '- **Visit Type:** {visit_type}',
  '- **Demographics:** Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}',
  '- **Recent Vitals:** {safe_vitals}',
  '- Language: {language_name}',
  '- Entities: {ner_entities}',
].join('\n');

/** The same body as L4 converts it — the AFTER side. */
const CONVERTED_BODY = LEGACY_BODY.replace(/\{([a-z_]+)\}/g, '{{context.$1}}');

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
    template: 'Pre-Summary Default Template',
    promptId: 'template-presummary',
    content,
    resolvedFrom: 'tenant',
    resolutionTrace: { usedDefaults: [] },
  });
}

describe('PromptAssemblyService renders `context.*` through the shared grammar', () => {
  it('resolves every legacy name under `context.*`', async () => {
    resolvesTo(CONVERTED_BODY);
    const { userPrompt } = await (await getService()).assemble(params());

    expect(userPrompt).toContain('- **Department:** Cardiology');
    expect(userPrompt).toContain('- **Visit Type:** revisit');
    expect(userPrompt).toContain('- **Demographics:** Age Unknown, DOB Unknown, Gender Unknown');
    expect(userPrompt).toContain('- Language: English');
    expect(userPrompt).not.toContain('{{');
  });

  it('leaves a single brace VERBATIM — the deleted grammar has no fallback pass', async () => {
    resolvesTo('Language: {language_name}');
    const { userPrompt } = await (await getService()).assemble(params());

    expect(userPrompt.startsWith('Language: {language_name}')).toBe(true);
  });

  it('binds a DECLARED name this call did not populate to the empty string, never a literal', async () => {
    resolvesTo('Prior: [{{context.prior_visit_summary}}]');
    const { userPrompt } = await (await getService()).assemble(params());

    expect(userPrompt.startsWith('Prior: []')).toBe(true);
  });

  it('honours `default("…")` over the empty binding', async () => {
    resolvesTo('Prior: {{context.prior_visit_summary | default("none recorded")}}');
    const { userPrompt } = await (await getService()).assemble(params());

    expect(userPrompt.startsWith('Prior: none recorded')).toBe(true);
  });

  it('never fails a consultation on an UNDECLARED reference — it renders empty and is logged', async () => {
    resolvesTo('Unknown: [{{context.not_a_declared_name}}]');
    const { userPrompt } = await (await getService()).assemble(params());

    expect(userPrompt.startsWith('Unknown: []')).toBe(true);
  });

  it('still assembles when the tenant has NO clone of the bridge schema (the L13 transition)', async () => {
    resolvesTo(CONVERTED_BODY);
    const { userPrompt } = await (await getService(false)).assemble(params());

    expect(userPrompt).toContain('- **Department:** Cardiology');
    expect(userPrompt).toContain('- Language: English');
  });

  it('reads the TENANT’s clone — never the SYSTEM row — when it has to classify a missing name', async () => {
    resolvesTo('Prior: [{{context.prior_visit_summary}}]');
    await (await getService()).assemble(params());

    expect(mockSchemaRepository.findByTenantAndSlug).toHaveBeenCalledWith('tenant-1', 'consultation_legacy_v1');
    expect(mockSchemaRepository.findByTenantAndSlug).not.toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000', expect.anything());
  });

  it('does NOT touch the schema row when every reference resolves — no DB read on the hot path', async () => {
    resolvesTo(CONVERTED_BODY);
    await (await getService()).assemble(params());

    expect(mockSchemaRepository.findByTenantAndSlug).not.toHaveBeenCalled();
  });
});

describe('the golden pair: converted content assembles byte-identically to the legacy body', () => {
  /** The pre-890 renderer, reproduced here so the BEFORE side survives its deletion. */
  function legacySubstitute(template: string, variables: Record<string, string>): string {
    return template.replace(/\{([a-zA-Z_][\w-]*)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match,
    );
  }

  it('produces the same string as the deleted single-brace substituter did', async () => {
    resolvesTo(CONVERTED_BODY);
    const { userPrompt } = await (await getService()).assemble(params());

    const before = legacySubstitute(LEGACY_BODY, {
      current_department: 'Cardiology',
      visit_type: 'revisit',
      safe_age: 'Unknown',
      safe_dob: 'Unknown',
      safe_gender: 'Unknown',
      safe_vitals: 'Not available',
      language_name: 'English',
      ner_entities: '',
    });

    expect(userPrompt.startsWith(before)).toBe(true);
  });
});
