/**
 * The `generate/assembled` text-proxy prompt composes through `composeMessages`: the template is
 * RENDERED (never sent as raw `{{…}}`), every context item is a delimited data block, and a
 * reference the route cannot supply is a 400 naming every path.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { platformRules } from '@arcaai/workflow-contract';
import { composeAssembledPrompt } from '../compose-assembled-prompt';

describe('composeAssembledPrompt', () => {
  it('renders the template over the visit-type label and wraps each context item as data', () => {
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
      `${platformRules()}\n\nYou are a cardiology scribe for a Revisit encounter.\n\nApply the following writing style:\nTerse.\n\nVisit type: Revisit.\n\nGenerate a clinical summary from the data sections.`,
    );
    expect(user).toBe(
      '<<<EXTERNAL_DATA section="transcript">>>\n--- Transcript ---\nChest pain on exertion.\n<<<END_EXTERNAL_DATA>>>\n\n' +
        '<<<EXTERNAL_DATA section="case_note">>>\n--- Case Note ---\nBP 150/90.\n<<<END_EXTERNAL_DATA>>>',
    );
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
