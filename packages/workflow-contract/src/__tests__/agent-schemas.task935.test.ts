/**
 * TASK-935 (R-2, OD-2 a / OD-5 a) — the ASR agent declares the clinical-vocabulary
 * correction stage, and declares NOTHING about its vocabulary.
 *
 * The terms are the agent's existing `instruction.hotwords` (OD-5 a: one list, two
 * consumers — the decoder prompt bias that TASK-934 shipped, and this correction
 * stage). A `terms` key here would be a second list free to drift from the first,
 * which is exactly what that decision refused, so its ABSENCE is the contract and
 * is asserted below.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '../agent-schemas';
import { forbiddenSchemaKeyProblems } from '../agentic-contract';

const props = (schema: unknown, ...path: string[]): Record<string, unknown> => {
  let cursor = schema as Record<string, unknown>;
  for (const key of path) {
    cursor = (cursor.properties as Record<string, Record<string, unknown>>)[key];
    if (cursor === undefined) throw new Error(`no property ${path.join('.')}`);
  }
  return cursor;
};

const asr = AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT;
const lexicon = (...path: string[]) => props(asr, 'postProcessing', 'lexicon', ...path);

describe('TASK-935 — postProcessing.lexicon (OD-2 a)', () => {
  it('is declared beside the post-processing stages it runs after', () => {
    expect(Object.keys(props(asr, 'postProcessing').properties as object).sort()).toEqual([
      'disfluency',
      'lexicon',
      'merge',
      'punctuation',
      'stabilizer',
    ]);
  });

  it('declares exactly enabled and maxDistance — never its own term list (OD-5 a)', () => {
    expect(Object.keys(lexicon().properties as object).sort()).toEqual(['enabled', 'maxDistance']);
    expect(lexicon().additionalProperties).toBe(false);
    expect(lexicon('enabled').type).toBe('boolean');
  });

  it('bounds maxDistance to the range the runtime accepts', () => {
    expect(lexicon('maxDistance')).toMatchObject({ type: 'number', minimum: 0.1, maximum: 0.5 });
  });

  it('documents where the terms come from and what absence means', () => {
    // The default is not a number an author can guess — it is conditional on the
    // hotwords, so the schema has to say so where the author is looking.
    const description = String(lexicon().description ?? '');
    expect(description).toMatch(/hotwords/i);
    expect(description).toMatch(/unset/i);
  });

  it('carries no forbidden schema keys', () => {
    // Keyed by node type on purpose: the key IS the label `forbiddenSchemaKeyProblems`
    // prefixes onto every problem it reports, and scanning the one schema this ticket
    // touches keeps the assertion scoped to TASK-935 (the sibling tests pass the whole
    // `AGENT_PARAMETER_SCHEMAS` record and cover the rest).
    expect(forbiddenSchemaKeyProblems({ SPEECH_TO_TEXT: asr })).toEqual([]);
  });
});
