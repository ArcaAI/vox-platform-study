/**
 * TASK-1034 R3 — the doctor's redaction rules rendered as a human-readable list for the prompt
 * (`dna_redaction_rules_text`). The deterministic post-generation pass stays the guarantee; this
 * text only tells the model what the engine will enforce anyway.
 */
import { describe, expect, it } from 'vitest';

import { renderDnaRedactionRulesText } from '../redaction-rules-text';

describe('renderDnaRedactionRulesText', () => {
  it('renders every rule shape as one bullet', () => {
    const text = renderDnaRedactionRulesText([
      { id: 'r1', type: 'remove', match: 'literal', pattern: 'Ms. Ada Byron' },
      { id: 'r2', type: 'rewrite', match: 'literal', pattern: 'pt', replacement: 'patient', note: 'expand abbreviations' },
      { id: 'r3', type: 'remove', match: 'regex', pattern: '\\bMRN\\s*\\d+' },
      { id: 'r4', type: 'rewrite', match: 'regex', pattern: '\\bSOB\\b', replacement: 'shortness of breath' },
      { id: 'r5', type: 'remove', match: 'category', pattern: 'patient names' },
      { id: 'r6', type: 'rewrite', match: 'category', pattern: 'judgemental language' },
      { id: 'r7', type: 'rewrite', match: 'category', pattern: 'brand drug names', replacement: 'the generic name' },
    ]);
    expect(text).toBe(
      [
        '- Never write "Ms. Ada Byron".',
        '- Always write "pt" as "patient". (expand abbreviations)',
        '- Never write text matching the pattern /\\bMRN\\s*\\d+/.',
        '- Write text matching the pattern /\\bSOB\\b/ as "shortness of breath".',
        '- Never include patient names.',
        '- Always rewrite judgemental language in neutral wording.',
        '- Always rewrite brand drug names as "the generic name".',
      ].join('\n'),
    );
  });

  it('accepts the persisted `{ rules }` container too', () => {
    expect(renderDnaRedactionRulesText({ rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'x' }] })).toBe('- Never write "x".');
  });

  it.each([[undefined], [null], [[]], [{ rules: [] }], ['nonsense'], [[{ id: 'r', type: 'delete', match: 'literal', pattern: 'x' }]]])(
    'is the empty string for %j — no rules, nothing to say',
    (input) => {
      expect(renderDnaRedactionRulesText(input)).toBe('');
    },
  );

  it('skips a malformed entry and keeps the rest', () => {
    expect(renderDnaRedactionRulesText([{ type: 'remove' }, { id: 'r1', type: 'remove', match: 'literal', pattern: 'x' }])).toBe(
      '- Never write "x".',
    );
  });
});
