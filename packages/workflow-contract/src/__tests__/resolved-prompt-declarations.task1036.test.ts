/**
 * TASK-1036 OD-10 (lane B6b) — a resolved prompt carries the variable DECLARATIONS of the template
 * version(s) it froze, and `resolvedPromptVariableDeclarations` reads them back for
 * `buildPromptScope({ variableDeclarations })`, on every lane. An artifact frozen before the field
 * existed carries none, and reads as `[]` — today's behaviour.
 */
import { describe, expect, it } from 'vitest';
import { composeMessages } from '../compose-messages';
import { resolvedPromptVariableDeclarations } from '../prompt-composition';
import { buildPromptScope } from '../prompt-scope';

describe('resolvedPromptVariableDeclarations', () => {
  it('reads a template prompt`s declarations', () => {
    const declarations = [{ name: 'tone', type: 'string' as const, required: false }];
    expect(
      resolvedPromptVariableDeclarations({
        source: 'template',
        promptTemplateId: 't',
        promptVersionNumber: 2,
        content: '{{tone}}',
        variables: declarations,
      }),
    ).toEqual(declarations);
  });

  it('unions a composite`s fragments, first declaration of a name winning', () => {
    expect(
      resolvedPromptVariableDeclarations({
        source: 'composite',
        content: '',
        join: '\n\n',
        fragments: [
          {
            key: 'a',
            source: 'template',
            promptTemplateId: 't1',
            promptVersionNumber: 1,
            content: '{{x}}',
            when: null,
            variables: [{ name: 'x', type: 'string', required: false }],
          },
          { key: 'b', source: 'inline', content: 'inline', when: null },
          {
            key: 'c',
            source: 'template',
            promptTemplateId: 't2',
            promptVersionNumber: 1,
            content: '{{x}} {{y}}',
            when: null,
            variables: [
              { name: 'x', type: 'string', required: true },
              { name: 'y', type: 'string', required: false, default: 'n/a' },
            ],
          },
        ],
      }).map((d) => [d.name, d.required, d.default]),
    ).toEqual([
      ['x', false, undefined],
      ['y', false, 'n/a'],
    ]);
  });

  it('is [] for inline, absent and pre-1036 artifacts', () => {
    expect(resolvedPromptVariableDeclarations({ source: 'inline', content: 'x' })).toEqual([]);
    expect(resolvedPromptVariableDeclarations(null)).toEqual([]);
    expect(resolvedPromptVariableDeclarations({ source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: 'x' })).toEqual([]);
  });

  it('with dropEmptyBlocks: an absent optional variable renders "" and an empty data block is dropped', () => {
    const resolvedPrompt = {
      source: 'template' as const,
      promptTemplateId: 't',
      promptVersionNumber: 1,
      content: 'Tone: {{tone}}.',
      variables: [{ name: 'tone', type: 'string' as const, required: false }],
    };
    const composed = composeMessages({
      platformRules: '',
      resolvedPrompt,
      scope: buildPromptScope({ variables: {}, variableDeclarations: resolvedPromptVariableDeclarations(resolvedPrompt) }),
      dataBlocks: [
        { key: 'notes', label: 'Notes', content: '  \n ' },
        { key: 'input', label: 'Input', content: 'hello' },
      ],
      dropEmptyBlocks: true,
    });
    expect(composed.system).toBe('Tone: .');
    expect(composed.blocks.map((block) => block.key)).toEqual(['input']);
  });
});
