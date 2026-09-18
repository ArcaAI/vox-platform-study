/**
 * TASK-934 (OD-4) — every decode knob that decides transcription quality is settable
 * ON THE AGENT, range-validated, not just on the model row.
 *
 * Six of them (`noSpeechThreshold`, `compressionRatioThreshold`, `logprobThreshold`,
 * `conditionOnPrevTokens`, `noRepeatNgramSize`, `prevTextContextWords`) were Python
 * literals in `InferenceConfig` with no wire field and no schema key at all — R-4's
 * "nothing left as a Python literal". `streaming.partialWindowSec` is the seventh: §2.2
 * measured 31 % garbage partials at a 6 s tail against 0 % at 15 s on the same weights,
 * so how long a partial window is IS an agent decision, not only model geometry.
 *
 * The ranges here MUST equal `AI_MODEL_ASR_PROFILE_DECODING_RANGES` in `@arcaai/types`:
 * the agent tier and the model tier feed the SAME engine field, so a value one tier
 * accepts and the other refuses would make the effective value depend on which tier
 * happened to supply it. This package deliberately has ZERO dependencies, so the two
 * tables cannot be compared here — they are literals below, and the cross-package
 * equality is asserted where both are importable:
 * `packages/applications/src/services/stt/agent-resolver/__tests__/build-resolved-asr-spec.test.ts`.
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
const decoding = (...path: string[]) => props(asr, 'decoding', ...path);
const streaming = (...path: string[]) => props(asr, 'streaming', ...path);

describe('TASK-934 — the ASR agent can set every decode knob (OD-4)', () => {
  it('declares every decode knob a tier may set, and nothing else', () => {
    // TASK-985 (QW-8 / QW-9) widened this surface by eight. `partial` and `final`
    // are the PER-PASS blocks — the same knobs again, scoped to one decode pass,
    // because a gate that is right on a committing decode is wrong on a partial
    // (precedence is pass -> flat -> dataclass default). The other six are knobs
    // whisper.cpp genuinely honours and the schema previously had no way to say.
    //
    // `entropyThreshold` is deliberately NOT an alias of `compressionRatioThreshold`:
    // they share a default of 2.4 and mean opposite things, so aliasing them would
    // have silently inverted a gate. Both are listed here for that reason.
    expect(Object.keys(decoding().properties as object).sort()).toEqual([
      'audioCtx',
      'beamSize',
      'chunkLengthSec',
      'codeSwitching',
      'compressionRatioThreshold',
      'conditionOnPrevTokens',
      'entropyThreshold',
      'final',
      'languageMode',
      'logprobThreshold',
      'maxTokens',
      'noRepeatNgramSize',
      'noSpeechThreshold',
      'partial',
      'prevTextContextWords',
      'singleSegment',
      'strideLengthSec',
      'suppressBlank',
      'suppressNonSpeechTokens',
      'temperature',
      'vadFilter',
      'wordTimestamps',
    ]);
  });

  /** The literal mirror of `AI_MODEL_ASR_PROFILE_DECODING_RANGES` (`@arcaai/types`). */
  const RANGES: ReadonlyArray<readonly [string, 'number' | 'integer', number, number]> = [
    ['beamSize', 'integer', 1, 10],
    ['temperature', 'number', 0, 1],
    ['noSpeechThreshold', 'number', 0, 1],
    ['compressionRatioThreshold', 'number', 1, 10],
    ['logprobThreshold', 'number', -10, 0],
    ['noRepeatNgramSize', 'integer', 0, 10],
    ['prevTextContextWords', 'integer', 0, 200],
  ];

  it.each(RANGES)('decoding.%s carries the SAME range as the model profile', (key, type, minimum, maximum) => {
    expect(decoding(key)).toMatchObject({ type, minimum, maximum });
  });

  it('types conditionOnPrevTokens as a boolean — it is a switch, not a threshold', () => {
    expect(decoding('conditionOnPrevTokens')).toMatchObject({ type: 'boolean' });
  });

  it('names the engine default and the ticket in every new description, so an admin knows what absence means', () => {
    for (const key of ['noSpeechThreshold', 'compressionRatioThreshold', 'logprobThreshold', 'conditionOnPrevTokens', 'noRepeatNgramSize', 'prevTextContextWords']) {
      const description = decoding(key).description as string;
      expect(description).toContain('TASK-934');
      expect(description).toMatch(/default/i);
    }
  });

  it('adds streaming.partialWindowSec with the model profile’s window range', () => {
    expect(streaming('partialWindowSec')).toMatchObject({ type: 'number', minimum: 1, maximum: 30 });
    expect(streaming('partialWindowSec').description as string).toContain('TASK-934');
  });

  it('does NOT put the decode window on the agent — geometry is a property of the weights (OD-3)', () => {
    expect(streaming().properties).not.toHaveProperty('maxDecodeWindowSec');
    expect(decoding().properties).not.toHaveProperty('maxDecodeWindowSec');
  });

  it('does NOT restate the prompt or the hotwords here — they belong to `instruction` (one path per engine field)', () => {
    expect(decoding().properties).not.toHaveProperty('initialPrompt');
    expect(decoding().properties).not.toHaveProperty('hotwords');
  });

  it('stays a closed object, so a typo is a publish problem rather than a silently dropped knob', () => {
    expect(decoding()).toMatchObject({ additionalProperties: false });
    expect(streaming()).toMatchObject({ additionalProperties: false });
    expect(forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS)).toEqual([]);
  });
});
