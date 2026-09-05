/**
 * The NATIVE Vox v2 pre-summary path must interpolate v1's
 * nine single-brace placeholders (D-08).
 *
 * The seeded pre-summary bodies (the ArcaAI tenant row AND the SYSTEM default
 * `71000000-…040`) are byte-exact v1 and therefore carry
 * `{current_department} {visit_type} {safe_age} {safe_dob} {safe_gender}
 * {safe_vitals} {formatted_test_results} {formatted_previous_visits}
 * {language_name}`. The compat shim substitutes them in
 * `summary-prompt.builder.ts`; the native path resolves the SAME body through
 * `PromptAssemblyService`, so without this the LLM receives literal braces.
 *
 * `PromptAssemblyService.assemble()` is the seam: it is the single point where
 * BOTH native entry points (`SummaryService.generatePreSummary` and
 * `PreSummaryProcessor`) converge on a resolved body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const V1_PRE_SUMMARY_BODY = [
  '- **Department:** {current_department}',
  '- **Visit Type:** {visit_type}',
  '- **Demographics:** Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}',
  '- **Recent Vitals:** {safe_vitals} (two most recent encounters)',
  '- **Test Results:** {formatted_test_results}',
  '- **Previous Visits:** {formatted_previous_visits}',
  '- Notes from {current_department}',
  '- Language: {language_name}',
].join('\n');

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };

async function getService(cls?: { get: (key: string) => unknown }) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as any,
    mockPromptTemplateRepository as any,
    mockDnaWritingStyleRepository as any,
    undefined, // harnessPolicyService
    cls as any,
    undefined, // exemplarRetriever
    undefined, // secretsService
    mockDepartmentRepository as any,
  );
}

describe('PromptAssemblyService — v1 pre-summary variables (native Vox v2 path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({
      template: 'Pre-Summary Default Template',
      promptId: 'template-presummary',
      content: V1_PRE_SUMMARY_BODY,
      resolvedFrom: 'tenant',
      resolutionTrace: { usedDefaults: [] },
    });
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'template-presummary', metaData: null });
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', name: 'Cardiology' });
  });

  it('leaves NO literal v1 placeholder in the assembled user prompt', async () => {
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      visitType: 'revisit',
    });

    for (const name of [
      'current_department',
      'visit_type',
      'safe_age',
      'safe_dob',
      'safe_gender',
      'safe_vitals',
      'formatted_test_results',
      'formatted_previous_visits',
      'language_name',
    ]) {
      expect(userPrompt).not.toContain(`{${name}}`);
    }
  });

  it("renders the department NAME resolved from departmentId, and the caller's visit type", async () => {
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
      visitType: 'revisit',
    });

    expect(mockDepartmentRepository.findById).toHaveBeenCalledWith('dept-1');
    expect(userPrompt).toContain('- **Department:** Cardiology');
    expect(userPrompt).toContain('- Notes from Cardiology');
    expect(userPrompt).toContain('- **Visit Type:** revisit');
  });

  it("resolves {language_name} from the conversation language via v1's LANGUAGE_MAP", async () => {
    const service = await getService();
    const ml = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'ml-IN',
    });
    expect(ml.userPrompt).toContain('- Language: Malayalam');

    const en = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });
    expect(en.userPrompt).toContain('- Language: English');
  });

  it("applies v1's defaults for the fields the native context has no equivalent for", async () => {
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });

    // No patient demographics / vitals / results exist in the v2 data model —
    // v1's own defaults apply, never an invented one.
    expect(userPrompt).toContain('- **Demographics:** Age Unknown, DOB Unknown, Gender Unknown');
    expect(userPrompt).toContain('- **Recent Vitals:** Not available (two most recent encounters)');
    expect(userPrompt).toContain('- **Test Results:** \n');
    expect(userPrompt).toContain('- **Previous Visits:** \n');
    // No visitType supplied ⇒ v1's default.
    expect(userPrompt).toContain('- **Visit Type:** Medical examination');
  });

  it("falls back to v1's 'General' when the consultation carries no department", async () => {
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });

    expect(mockDepartmentRepository.findById).not.toHaveBeenCalled();
    expect(userPrompt).toContain('- **Department:** General');
  });

  it("falls back to 'General' when the department row cannot be read (never fails the generation)", async () => {
    mockDepartmentRepository.findById.mockRejectedValue(new Error('db down'));
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });
    expect(userPrompt).toContain('- **Department:** General');
  });

  it('does not touch the department repository for a body with no v1 placeholders', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({
      template: 'Surgery-NewReferral',
      promptId: 'template-001',
      content: 'Summarize for {conversation_language}.',
      resolvedFrom: 'department',
      resolutionTrace: { usedDefaults: [] },
    });

    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'new-patient',
      transcript: 'transcript',
      conversationLanguage: 'en',
    });

    expect(mockDepartmentRepository.findById).not.toHaveBeenCalled();
    expect(userPrompt).toContain('Summarize for en.');
  });

  /**
   * Follow-up. The pre-summary chain has NO department axis, so
   * `resolvePreSummaryPromptId` needs the tenant explicitly: without it a
   * consultation with no department skips the tenant tier and lands on the
   * SYSTEM default — or a 503. `assemble()` runs its own `resolve()` (the one
   * that actually picks the body the LLM sees), so threading the tenant only at
   * the processor's separate debug-`resolve()` would fix the log line and not
   * the prompt.
   */
  it('threads the tenant into resolve() so the pre-summary tenant tier is reachable without a department', async () => {
    const service = await getService();
    await service.assemble({
      tenantId: 'tenant-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
  });

  it('falls back to the CLS tenant when the caller passes none', async () => {
    const service = await getService({ get: (key: string) => (key === 'tenantId' ? 'tenant-from-cls' : undefined) });
    await service.assemble({
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-from-cls' }));
  });

  it('substitutes in ONE pass — a brace inside a substituted value is never re-interpreted', async () => {
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', name: '{safe_vitals}' });
    const service = await getService();
    const { userPrompt } = await service.assemble({
      tenantId: 'tenant-1',
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      transcript: 'case notes',
      conversationLanguage: 'en',
    });
    expect(userPrompt).toContain('- **Department:** {safe_vitals}');
    expect(userPrompt).toContain('- **Recent Vitals:** Not available');
  });
});
