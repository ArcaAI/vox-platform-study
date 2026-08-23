/**
 * `dataType` translation for the registry lane (TASK-799 Phase 4, E.1).
 *
 * The write lane validates `value` against the descriptor's declared type and
 * 400s a mismatch, so these conversions are the difference between a save and a
 * rejected request. Phase 1 made non-numeric values first-class — the point of
 * these tests is that every declared type round-trips, not just `number`.
 */

import { describe, expect, it } from 'vitest';
import { formatValue, fromDraft, toDraft } from '../registry-value';

describe('toDraft — stored value as editable text', () => {
  it('renders booleans as the literal token the switch reads', () => {
    expect(toDraft('boolean', true)).toBe('true');
    expect(toDraft('boolean', false)).toBe('false');
  });

  it('renders a string[] one entry per line, so a list is edited as a list', () => {
    expect(toDraft('string[]', ['pii', 'phi'])).toBe('pii\nphi');
  });

  it('pretty-prints json so the code editor is readable', () => {
    expect(toDraft('json', { a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('renders 0 and false as values, not as absences', () => {
    expect(toDraft('number', 0)).toBe('0');
    expect(toDraft('boolean', false)).toBe('false');
  });

  it('renders a missing value as empty', () => {
    expect(toDraft('string', null)).toBe('');
    expect(toDraft('number', undefined)).toBe('');
  });
});

describe('fromDraft — text as the typed value the gateway expects', () => {
  it('sends a number as a NUMBER, not a string', () => {
    const result = fromDraft('number', '9000');
    expect(result.ok).toBe(true);
    expect(typeof result.value).toBe('number');
    expect(result.value).toBe(9000);
  });

  it('refuses non-numeric text with a reason, rather than sending NaN', () => {
    const result = fromDraft('number', 'lots');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a number');
  });

  it('refuses an empty number rather than coercing it to 0', () => {
    expect(fromDraft('number', '  ').ok).toBe(false);
  });

  it('sends a boolean as a BOOLEAN', () => {
    expect(fromDraft('boolean', 'true').value).toBe(true);
    expect(fromDraft('boolean', 'false').value).toBe(false);
  });

  it('sends a string[] as an ARRAY, dropping blank lines', () => {
    const result = fromDraft('string[]', 'pii\n\n  phi  \n');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(['pii', 'phi']);
  });

  it('allows an empty string[] — clearing a list is a legitimate value', () => {
    const result = fromDraft('string[]', '');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([]);
  });

  it('parses json into a structure, not a string', () => {
    const result = fromDraft('json', '{"a":1}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ a: 1 });
  });

  it('refuses invalid json with the parser message', () => {
    const result = fromDraft('json', '{nope');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid JSON/);
  });

  it('passes string and enum through verbatim, including whitespace the admin typed', () => {
    expect(fromDraft('string', 'a b').value).toBe('a b');
    expect(fromDraft('enum', 'AGGRESSIVE').value).toBe('AGGRESSIVE');
  });

  it('allows an empty string — an empty value is not the same as no value', () => {
    expect(fromDraft('string', '').ok).toBe(true);
  });

  it('refuses to produce a value for a secret, even if asked directly', () => {
    // The drawer blocks this case earlier; this is the backstop that keeps the
    // refusal true if a future caller forgets.
    expect(fromDraft('secret', 'hunter2').ok).toBe(false);
  });
});

describe('round trip', () => {
  it.each([
    ['boolean', true],
    ['number', 42],
    ['string', 'hello'],
    ['string[]', ['a', 'b']],
    ['json', { nested: { ok: true } }],
  ] as const)('%s survives toDraft -> fromDraft unchanged', (dataType, value) => {
    const result = fromDraft(dataType, toDraft(dataType, value));
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(value);
  });
});

describe('formatValue — the one-line list rendering', () => {
  it('joins a list rather than printing [object Object]', () => {
    expect(formatValue('string[]', ['a', 'b'])).toBe('a, b');
  });

  it('says an empty list is empty rather than rendering nothing', () => {
    expect(formatValue('string[]', [])).toBe('(empty list)');
  });

  it('marks a missing value with a dash', () => {
    expect(formatValue('string', null)).toBe('—');
  });
});
