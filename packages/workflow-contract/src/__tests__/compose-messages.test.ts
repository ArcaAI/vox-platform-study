/**
 * `composeMessages` — the ONE way an LLM request's system and user messages are built.
 *
 * The byte-level contract across TypeScript and Python lives in
 * `tests/contracts/compose-messages.fixture.json`; this file pins the rules one at a time so a
 * regression names the rule it broke.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_DATA_TRUNCATION_MARKER,
  PLATFORM_RULES_VERSION,
  PromptCompositionEmptyError,
  PromptVariableUnresolvedError,
  composeMessages,
  outputLanguageStep,
  platformRules,
} from '../index';

const RULES = 'RULES';

describe('composeMessages — system layering', () => {
  it('joins platform rules → instruction → output-language step → output contract with a blank line', () => {
    const result = composeMessages({
      platformRules: RULES,
      resolvedPrompt: { source: 'inline', content: 'Write a note for {{context.name}}.' },
      scope: { context: { name: 'Ada' } },
      outputLanguage: { name: 'English' },
      outputContract: 'Return JSON.',
    });
    expect(result.system).toBe(['RULES', 'Write a note for Ada.', outputLanguageStep('English'), 'Return JSON.'].join('\n\n'));
    expect(result.user).toBe('');
  });

  it('omits every empty layer, including a null instruction', () => {
    const result = composeMessages({ platformRules: RULES, resolvedPrompt: null, scope: {}, outputLanguage: null, outputContract: '' });
    expect(result.system).toBe('RULES');
  });

  it('omits the language step when the name is empty', () => {
    const result = composeMessages({
      platformRules: '',
      resolvedPrompt: { source: 'inline', content: 'X' },
      scope: {},
      outputLanguage: { name: '' },
    });
    expect(result.system).toBe('X');
  });

  it('names the language in one fixed sentence', () => {
    expect(outputLanguageStep('Malayalam')).toContain('Malayalam');
    expect(outputLanguageStep('Malayalam').split('\n')).toHaveLength(1);
  });

  it('honours conditional fragments and reports selection', () => {
    const result = composeMessages({
      platformRules: RULES,
      resolvedPrompt: {
        source: 'composite',
        content: 'base',
        join: '\n\n',
        fragments: [
          { key: 'base', source: 'inline', content: 'base', when: null },
          { key: 'revisit', source: 'inline', content: 'revisit', when: "context.visit_type == 'revisit'" },
        ],
      },
      scope: { context: { visit_type: 'new' } },
    });
    expect(result.system).toBe('RULES\n\nbase');
    expect(result.selected).toEqual(['base']);
    expect(result.excluded).toEqual([{ key: 'revisit', reason: 'condition_false' }]);
  });

  it('propagates an empty composition by name', () => {
    expect(() =>
      composeMessages({
        platformRules: RULES,
        resolvedPrompt: { source: 'composite', content: '', join: '\n\n', fragments: [{ key: 'a', source: 'inline', content: 'a', when: 'false' }] },
        scope: {},
      }),
    ).toThrow(PromptCompositionEmptyError);
  });
});

describe('composeMessages — missing variables', () => {
  it('throws PromptVariableUnresolvedError naming EVERY missing path, never rendering empty', () => {
    let caught: unknown;
    try {
      composeMessages({
        platformRules: RULES,
        resolvedPrompt: { source: 'inline', content: '{{context.b}} {{context.a}} {{context.ok}} {{context.c | default("x")}}' },
        scope: { context: { ok: 'y' } },
        templateRef: 'agent:x',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromptVariableUnresolvedError);
    const error = caught as PromptVariableUnresolvedError;
    expect(error.paths).toEqual(['context.a', 'context.b']);
    expect(error.path).toBe('context.a');
    expect(error.code).toBe('PROMPT_VARIABLE_UNRESOLVED');
    expect(error.templateRef).toBe('agent:x');
    expect(error.message).toContain('context.a');
    expect(error.message).toContain('context.b');
  });

  it('only counts variables of SELECTED fragments', () => {
    const result = composeMessages({
      platformRules: '',
      resolvedPrompt: {
        source: 'composite',
        content: 'base',
        join: '\n\n',
        fragments: [
          { key: 'base', source: 'inline', content: 'base', when: null },
          { key: 'x', source: 'inline', content: '{{context.absent}}', when: 'false' },
        ],
      },
      scope: { context: {} },
    });
    expect(result.system).toBe('base');
  });
});

describe('composeMessages — user data blocks', () => {
  it('wraps blocks in the given order and skips empty or null ones', () => {
    const result = composeMessages({
      platformRules: RULES,
      resolvedPrompt: null,
      scope: {},
      dataBlocks: [
        { key: 'transcript', label: 'Transcript', content: 'hello' },
        { key: 'notes', label: 'Notes', content: null },
        { key: 'empty', label: 'Empty', content: '' },
        { key: 'vitals', label: 'Vitals', content: 'bp 120/80' },
      ],
    });
    expect(result.user).toBe(
      [
        '<<EXTERNAL_DATA key="transcript" label="Transcript">>\nhello\n<<END_EXTERNAL_DATA>>',
        '<<EXTERNAL_DATA key="vitals" label="Vitals">>\nbp 120/80\n<<END_EXTERNAL_DATA>>',
      ].join('\n\n'),
    );
    expect(result.blocks).toEqual([
      { key: 'transcript', chars: 5, truncated: false },
      { key: 'vitals', chars: 9, truncated: false },
    ]);
  });

  it('cuts an over-budget block at the last newline before the cap and marks it', () => {
    const result = composeMessages({
      platformRules: '',
      resolvedPrompt: null,
      scope: {},
      dataBlocks: [{ key: 't', label: 'T', content: 'line one\nline two\nline three', maxChars: 20 }],
    });
    expect(result.user).toBe(`<<EXTERNAL_DATA key="t" label="T">>\nline one\nline two${EXTERNAL_DATA_TRUNCATION_MARKER}\n<<END_EXTERNAL_DATA>>`);
    expect(EXTERNAL_DATA_TRUNCATION_MARKER).toBe('\n[…truncated]');
    expect(result.blocks).toEqual([{ key: 't', chars: 17, truncated: true }]);
  });

  it('hard-cuts at the cap when there is no newline before it, counting code points', () => {
    const result = composeMessages({
      platformRules: '',
      resolvedPrompt: null,
      scope: {},
      dataBlocks: [{ key: 't', label: 'T', content: '😀😀😀abc', maxChars: 4 }],
    });
    expect(result.user).toBe(`<<EXTERNAL_DATA key="t" label="T">>\n😀😀😀a${EXTERNAL_DATA_TRUNCATION_MARKER}\n<<END_EXTERNAL_DATA>>`);
    expect(result.blocks).toEqual([{ key: 't', chars: 4, truncated: true }]);
  });

  it('leaves a block at exactly the cap untouched', () => {
    const result = composeMessages({
      platformRules: '',
      resolvedPrompt: null,
      scope: {},
      dataBlocks: [{ key: 't', label: 'T', content: 'abcd', maxChars: 4 }],
    });
    expect(result.blocks).toEqual([{ key: 't', chars: 4, truncated: false }]);
  });
});

describe('platformRules', () => {
  it('is the one platform system text, versioned', () => {
    expect(platformRules()).toMatch(/^You are a clinical documentation assistant\./);
    expect(platformRules()).toContain('PLATFORM RULES');
    expect(typeof PLATFORM_RULES_VERSION).toBe('string');
    expect(PLATFORM_RULES_VERSION.length).toBeGreaterThan(0);
  });
});
