/**
 * The `generate/assembled` text-proxy prompt composes through `composeMessages`: the template is
 * RENDERED (never sent as raw `{{…}}`), every context item is a delimited data block, and a
 * reference the route cannot supply is a 400 naming every path.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { composeMessages, platformRules } from '@arcaai/workflow-contract';
import { DNA_STYLE_GUIDANCE } from '../../consultation/prompt/style-reference';
import { composeAssembledPrompt } from '../compose-assembled-prompt';

vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, composeMessages: vi.fn(actual.composeMessages) };
});

describe('composeAssembledPrompt', () => {
  // TASK-1047 D1 / FC-1 — the visit label and the clinician's style are RUNTIME values: data blocks.
  // The system message is the rules, the template with a pointer, and static guidance only.
  it('points the template at the visit-type block and carries the style and every context item as data', () => {
    const { system, user } = composeAssembledPrompt({
      templateContent: 'You are a cardiology scribe for a {{visit_type}} encounter.',
      type: 'summary',
      visitLabel: 'Revisit',
      styleText: 'Terse.',
      blocks: [
        { key: 'transcript', label: 'Transcript', content: 'Chest pain on exertion.' },
        { key: 'case_note', label: 'Case Note', content: 'BP 150/90.' },
      ],
    });

    expect(system).toBe(
      `${platformRules()}\n\nYou are a cardiology scribe for a [see the visit_type data section below] encounter.\n\n${DNA_STYLE_GUIDANCE}\n\nGenerate a clinical summary from the data sections.`,
    );
    expect(user).toBe(
      '<<<EXTERNAL_DATA section="style_reference">>>\n--- STYLE REFERENCE ---\n--- CLINICIAN WRITING STYLE ---\nTerse.\n<<<END_EXTERNAL_DATA>>>\n\n' +
        '<<<EXTERNAL_DATA section="visit_type">>>\n--- VISIT TYPE ---\nRevisit\n<<<END_EXTERNAL_DATA>>>\n\n' +
        '<<<EXTERNAL_DATA section="transcript">>>\n--- Transcript ---\nChest pain on exertion.\n<<<END_EXTERNAL_DATA>>>\n\n' +
        '<<<EXTERNAL_DATA section="case_note">>>\n--- Case Note ---\nBP 150/90.\n<<<END_EXTERNAL_DATA>>>',
    );
  });

  it('keeps every runtime value out of the system side it hands the composer', () => {
    composeAssembledPrompt({ templateContent: null, type: 'summary', visitLabel: 'Revisit-LABEL', styleText: 'STYLE-TEXT', blocks: [] });
    const input = vi.mocked(composeMessages).mock.calls.at(-1)![0];
    const systemSide = [input.platformRules, input.outputContract ?? '', ...(input.outputContractParts ?? []).map((part) => part.text)].join('\n');
    expect(systemSide).not.toContain('Revisit-LABEL');
    expect(systemSide).not.toContain('STYLE-TEXT');
    expect(input.outputContract).toBeUndefined();
    expect((input.outputContractParts ?? []).map((part) => part.key)).toEqual(['dna-style', 'assembled-task']);
    expect(input.blockAliases).toMatchObject({ visit_type: 'visit_type', 'variables.visit_type': 'visit_type' });
  });

  it('returns the composed governance and the platform pieces it emitted (FC-4)', () => {
    const composed = composeAssembledPrompt({ templateContent: null, type: 'summary', styleText: 'Terse.', blocks: [] });
    expect(composed.governance?.composedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(composed.platformPieces.map((piece) => [piece.kind, piece.sourceKey])).toEqual([
      ['PLATFORM', expect.stringMatching(/^platform-rules@/)],
      ['CONTRACT', 'dna-style'],
      ['CONTRACT', 'assembled-task'],
    ]);
  });

  it('never sends an unrendered placeholder: an unsupplied reference is a 400 naming every path', () => {
    const attempt = () =>
      composeAssembledPrompt({
        templateContent: 'Age {{context.safe_age}}, department {{context.current_department}}.',
        type: 'summary',
        blocks: [{ key: 'message', label: 'Message', content: 'x' }],
      });

    expect(attempt).toThrow(BadRequestException);
    try {
      attempt();
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PROMPT_VARIABLE_UNRESOLVED',
        missingVariables: ['context.current_department', 'context.safe_age'],
      });
    }
  });

  it('uses the platform default instruction for the type when no template is named', () => {
    const { system } = composeAssembledPrompt({ templateContent: null, type: 'pre-summary', blocks: [] });
    expect(system).toContain('Generate a concise pre-summary from the provided clinical context.');
    expect(system.endsWith('Generate a pre-summary from the data sections.')).toBe(true);
  });
});
