/**
 * PromptAssemblyService — re-visit carry-forward block.
 *
 * Carry-forward is the highest-risk context feature in the platform (SOTA :
 * it inherits the copy-paste / cloned-note failure mode), so the tests here lock
 * three properties rather than just "the text appears":
 *
 *  1. **Off by default at the prompt layer too.** No `priorVisitSummary` ⇒ the
 *     assembled prompt is byte-identical to the pre-feature prompt. The knob that
 *     decides whether a producer supplies the value lives in
 *     `harness-internal.service`; this is the second, independent gate.
 *  2. **Never authoritative.** The block carries an explicit non-authoritative
 *     preamble telling the model to re-confirm against the current transcript,
 *     and it is wrapped in the same `<<<EXTERNAL_DATA …>>>` spotlighting markers
 *     the platform system prompt declares are data, never instructions.
 *  3. **Bounded.** A long prior note is truncated at a hard cap with a visible
 *     marker, so a multi-visit episode cannot grow the prompt without limit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PRIOR_VISIT_SUMMARY_MAX_CHARS,
  PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER,
} from '../../../settings-registry/descriptors/agentic-revisit.descriptors';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-revisit';

function createTemplate(content = 'Summarize for {conversation_language}.') {
  return {
    id: 'template-revisit',
    name: 'Revisit',
    content,
    variables: { conversation_language: { type: 'string', required: true } },
    metaData: { promptConfig: { hyperparameters: {}, outputSchema: null } },
  };
}

async function buildService() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    { get: vi.fn() } as never,
    { getEffectivePolicy: vi.fn().mockResolvedValue({ warmStartEnabled: false }) } as never,
    { get: vi.fn() } as never,
  );
}

const assemble = (service: { assemble: (p: unknown) => Promise<{ userPrompt: string }> }, extra: Record<string, unknown> = {}) =>
  service.assemble({
    tenantId: TENANT,
    departmentId: 'dept-1',
    promptType: 'revisit',
    transcript: 'TRANSCRIPT-MARKER patient returns for follow-up',
    conversationLanguage: 'en',
    ...extra,
  });

describe('PromptAssemblyService — prior-visit carry-forward', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-revisit', resolvedFrom: 'department' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('omits the block entirely when no prior-visit summary is supplied (regression lock)', async () => {
    const service = await buildService();

    const { userPrompt } = await assemble(service as never);

    expect(userPrompt).not.toContain('prior_visit_summary');
    expect(userPrompt).not.toContain('PRIOR VISIT SUMMARY');
  });

  it('appends a spotlighting-wrapped, explicitly non-authoritative block when supplied', async () => {
    const service = await buildService();

    const { userPrompt } = await assemble(service as never, { priorVisitSummary: 'PRIOR-NOTE-MARKER hypertension stable on ramipril' });

    expect(userPrompt).toContain('<<<EXTERNAL_DATA section="prior_visit_summary">>>');
    expect(userPrompt).toContain('PRIOR-NOTE-MARKER hypertension stable on ramipril');
    expect(userPrompt).toContain('<<<END_EXTERNAL_DATA>>>');
    // The safety preamble is the whole point of the feature — assert its load-bearing clauses.
    expect(userPrompt).toMatch(/re-?confirm/i);
    expect(userPrompt).toMatch(/previous encounter|prior visit/i);
    expect(userPrompt).toMatch(/not.*current[- ]visit evidence|never.*without current-visit evidence/i);
  });

  it('substitutes {prior_visit_summary} when the template consumes it, without appending a duplicate block', async () => {
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate('Summarize for {conversation_language}. Prior: {prior_visit_summary}.'));
    const service = await buildService();

    const { userPrompt } = await assemble(service as never, { priorVisitSummary: 'PRIOR-NOTE-MARKER stable' });

    expect(userPrompt).not.toContain('{prior_visit_summary}');
    // Consumed by the template ⇒ exactly one occurrence, no appended duplicate.
    expect(userPrompt.split('PRIOR-NOTE-MARKER stable').length - 1).toBe(1);
  });

  it('truncates an oversized prior-visit summary with a visible marker', async () => {
    const service = await buildService();
    const long = 'x'.repeat(PRIOR_VISIT_SUMMARY_MAX_CHARS + 5_000);

    const { userPrompt } = await assemble(service as never, { priorVisitSummary: long });

    expect(userPrompt).toContain(PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER);
    expect(userPrompt).not.toContain('x'.repeat(PRIOR_VISIT_SUMMARY_MAX_CHARS + 1));
  });

  it('no longer accepts the dead sameDayPrequelSummary variable', async () => {
    mockPromptTemplateRepository.findById.mockResolvedValue(
      createTemplate('Summarize for {conversation_language}. Prequel: {same_day_prequel_summary}.'),
    );
    const service = await buildService();

    const { userPrompt } = await assemble(service as never, { sameDayPrequelSummary: 'SHOULD-NOT-APPEAR' });

    expect(userPrompt).not.toContain('SHOULD-NOT-APPEAR');
    // The placeholder is left untouched (no producer, no variable) rather than silently filled.
    expect(userPrompt).toContain('{same_day_prequel_summary}');
  });
});
