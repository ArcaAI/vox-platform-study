/**
 * `PromptAssemblyService` composes through the ONE composer (`composeMessages`).
 *
 *  - the governed body is the SYSTEM message, after the platform rules, followed by the
 *    output-language step — never the user message;
 *  - per-encounter data is delimiter-wrapped in the USER message, in a fixed order;
 *  - a COMPOSITE agent resolved by an agent tier composes every fragment over the render scope,
 *    so a conditional fragment applies on finalize exactly as on the agent lanes (the primary
 *    template is only its governance pointer);
 *  - a reference nothing populates is a 400 naming every path (`grammar.task890` pins the shape).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { outputLanguageStep, platformRules } from '@arcaai/workflow-contract';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };

async function getService() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
  );
}

const base = { tenantId: 'tenant-1', promptType: 'revisit', transcript: 'TRANSCRIPT-MARKER', conversationLanguage: 'en' };

beforeEach(() => {
  vi.clearAllMocks();
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', metaData: null });
});

describe('the body is the SYSTEM message', () => {
  it('composes platform rules → body → output-language step, and keeps data out of it', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'tpl-1', content: 'Write the SOAP note.', resolvedFrom: 'department' });

    const { systemPrompt, userPrompt } = await (await getService()).assemble({ ...base });

    expect(systemPrompt).toBe(`${platformRules()}\n\nWrite the SOAP note.\n\n${outputLanguageStep('English')}`);
    expect(userPrompt).toBe('<<<EXTERNAL_DATA section="transcript">>>\n--- TRANSCRIPT ---\nTRANSCRIPT-MARKER\n<<<END_EXTERNAL_DATA>>>');
  });

  it('reports the emitted data sections, in order', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'tpl-1', content: 'Body.', resolvedFrom: 'department' });

    const assembled = await (await getService()).assemble({ ...base, clinicianNotes: ['[case note] review'], vitals: 'BP 120/80' });

    expect(assembled.blocks?.map((block) => block.key)).toEqual(['transcript', 'clinician_notes', 'recent_vitals']);
  });
});

describe('a COMPOSITE agent instruction composes on finalize (no primary-template shortcut)', () => {
  const composite = {
    source: 'composite' as const,
    content: 'BASE body.',
    join: '\n\n',
    fragments: [
      { key: 'base', source: 'inline' as const, content: 'BASE body.' },
      { key: 'revisit', source: 'inline' as const, content: 'REVISIT branch for {{trigger.context.current_department}}.', when: "trigger.context.visit_type == 'revisit'" },
      { key: 'new', source: 'inline' as const, content: 'NEW-VISIT branch.', when: "trigger.context.visit_type == 'new-visit'" },
    ],
  };

  it('selects the fragment whose condition holds and renders it over the assembly scope', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({
      promptId: 'tpl-1',
      // The primary template snapshot — the governance pointer, NOT what is composed.
      content: 'PRIMARY TEMPLATE ONLY.',
      resolvedFrom: 'agent',
      resolvedPrompt: composite,
      promptVariables: {},
    });

    const assembled = await (await getService()).assemble({ ...base, promptType: 'pre-summary', visitType: 'revisit' });

    expect(assembled.systemPrompt).toContain('BASE body.\n\nREVISIT branch for General.');
    expect(assembled.systemPrompt).not.toContain('NEW-VISIT branch.');
    expect(assembled.systemPrompt).not.toContain('PRIMARY TEMPLATE ONLY.');
    expect(assembled.selected).toEqual(['base', 'revisit']);
    expect(assembled.excluded).toEqual([{ key: 'new', reason: 'condition_false' }]);
  });

  it('resolves the agent’s own `{ path: trigger.context.* }` bindings against the assembly scope', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({
      promptId: 'tpl-1',
      content: 'x',
      resolvedFrom: 'agent',
      resolvedPrompt: { ...composite, fragments: [{ key: 'base', source: 'inline', content: 'Language {{lang}}; complaint [{{complaint}}].' }] },
      promptVariables: { lang: { path: 'trigger.context.language' }, complaint: { path: 'trigger.context.chief_complaint' } },
    });

    const { systemPrompt } = await (await getService()).assemble({ ...base });

    expect(systemPrompt).toContain('Language en; complaint [].');
  });
});
