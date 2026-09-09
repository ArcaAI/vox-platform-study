/**
 * TASK-934 (lane P) — `AiModelAsrProfile`: the typed shape of `AiModel._metadata.asr`
 * and its parser.
 *
 * The row is admin-editable JSON, so the parser is the boundary between "what an
 * admin typed" and "what the resolver may act on". Tuning knobs are
 * `open-to-default` (rule 09 §Configuration Tiers): an out-of-range or
 * wrong-typed member is DROPPED and NAMED in `rejected` — never fail-closed, and
 * never forwarded to a runtime that would `float()` it.
 */
import { describe, expect, it } from 'vitest';
import { parseAiModelAsrProfile } from '../asr-model-profile.js';

describe('parseAiModelAsrProfile — the happy path', () => {
  it('reads every declared member of a full profile', () => {
    const { profile, rejected } = parseAiModelAsrProfile({
      maxDecodeWindowSec: 7,
      partialWindowSec: 15,
      initialPrompt: 'Clinical consultation. Medical terminology.',
      decoding: {
        beamSize: 5,
        temperature: 0,
        noSpeechThreshold: 0.4,
        compressionRatioThreshold: 2.4,
        logprobThreshold: -1,
        conditionOnPrevTokens: false,
        noRepeatNgramSize: 3,
        prevTextContextWords: 50,
        hotwords: ['paracetamol', 'metformin'],
      },
    });
    expect(rejected).toEqual([]);
    expect(profile).toEqual({
      maxDecodeWindowSec: 7,
      partialWindowSec: 15,
      initialPrompt: 'Clinical consultation. Medical terminology.',
      decoding: {
        beamSize: 5,
        temperature: 0,
        noSpeechThreshold: 0.4,
        compressionRatioThreshold: 2.4,
        logprobThreshold: -1,
        conditionOnPrevTokens: false,
        noRepeatNgramSize: 3,
        prevTextContextWords: 50,
        hotwords: ['paracetamol', 'metformin'],
      },
    });
  });

  it('returns an EMPTY profile (never undefined members) for a row that declares nothing', () => {
    for (const raw of [undefined, null, {}, 'nonsense', 7, []]) {
      const { profile, rejected } = parseAiModelAsrProfile(raw);
      expect(profile).toEqual({});
      expect(rejected).toEqual([]);
    }
  });

  it('omits a member the row did not declare rather than encoding it as null', () => {
    const { profile } = parseAiModelAsrProfile({ maxDecodeWindowSec: 7 });
    expect(profile).toEqual({ maxDecodeWindowSec: 7 });
    expect(profile).not.toHaveProperty('partialWindowSec');
    expect(profile).not.toHaveProperty('decoding');
    expect(profile).not.toHaveProperty('initialPrompt');
  });

  it('omits an all-rejected decoding block rather than emitting an empty object', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { beamSize: 99 } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual(['decoding.beamSize']);
  });
});

describe('parseAiModelAsrProfile — ranges (the value is dropped AND named)', () => {
  const outOfRange: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['maxDecodeWindowSec', 0, 31],
    ['partialWindowSec', 0.5, 30.5],
  ];

  it.each(outOfRange)('%s rejects a value below or above its range', (key, low, high) => {
    for (const value of [low, high]) {
      const { profile, rejected } = parseAiModelAsrProfile({ [key]: value });
      expect(profile).not.toHaveProperty(key);
      expect(rejected).toEqual([key]);
    }
  });

  const decodingRanges: ReadonlyArray<readonly [string, unknown, unknown, unknown]> = [
    // [key, a valid value, a value below the floor, a value above the ceiling]
    ['beamSize', 1, 0, 11],
    ['temperature', 0.2, -0.1, 1.1],
    ['noSpeechThreshold', 0.6, -0.01, 1.01],
    ['compressionRatioThreshold', 2.4, 0.9, 10.1],
    ['logprobThreshold', -1, -10.1, 0.1],
    ['noRepeatNgramSize', 0, -1, 11],
    ['prevTextContextWords', 50, -1, 201],
  ];

  it.each(decodingRanges)('decoding.%s accepts its range and rejects outside it', (key, ok, low, high) => {
    expect(parseAiModelAsrProfile({ decoding: { [key]: ok } }).profile.decoding).toEqual({ [key]: ok });
    for (const value of [low, high]) {
      const { profile, rejected } = parseAiModelAsrProfile({ decoding: { [key]: value } });
      expect(profile).not.toHaveProperty('decoding');
      expect(rejected).toEqual([`decoding.${key}`]);
    }
  });

  it.each(['beamSize', 'noRepeatNgramSize', 'prevTextContextWords'])('decoding.%s rejects a non-integer', (key) => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { [key]: 2.5 } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual([`decoding.${key}`]);
  });

  it('rejects a non-boolean conditionOnPrevTokens', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { conditionOnPrevTokens: 'yes' } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual(['decoding.conditionOnPrevTokens']);
  });

  it('rejects a hotword list that is not an array of non-empty strings, or is longer than 64', () => {
    for (const hotwords of ['paracetamol', [1, 2], ['ok', ''], Array.from({ length: 65 }, (_, i) => `w${i}`)]) {
      const { profile, rejected } = parseAiModelAsrProfile({ decoding: { hotwords } });
      expect(profile).not.toHaveProperty('decoding');
      expect(rejected).toEqual(['decoding.hotwords']);
    }
    expect(parseAiModelAsrProfile({ decoding: { hotwords: [] } }).profile.decoding).toEqual({ hotwords: [] });
    expect(parseAiModelAsrProfile({ decoding: { hotwords: Array.from({ length: 64 }, (_, i) => `w${i}`) } }).rejected).toEqual([]);
  });

  it('rejects an initialPrompt that is not a non-empty string of at most 1000 characters', () => {
    for (const initialPrompt of ['', 7, 'x'.repeat(1001)]) {
      const { profile, rejected } = parseAiModelAsrProfile({ initialPrompt });
      expect(profile).not.toHaveProperty('initialPrompt');
      expect(rejected).toEqual(['initialPrompt']);
    }
    expect(parseAiModelAsrProfile({ initialPrompt: 'x'.repeat(1000) }).rejected).toEqual([]);
  });

  it('rejects a non-finite number rather than forwarding NaN/Infinity to a float()', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ maxDecodeWindowSec: Number.NaN, decoding: { temperature: Number.POSITIVE_INFINITY } });
    expect(profile).toEqual({});
    expect(rejected).toEqual(['maxDecodeWindowSec', 'decoding.temperature']);
  });
});

describe('parseAiModelAsrProfile — unknown keys are dropped and named', () => {
  it('names an unknown top-level key by path and keeps the known siblings', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ maxDecodeWindowSec: 7, bestOf: 5, patience: 1 });
    expect(profile).toEqual({ maxDecodeWindowSec: 7 });
    expect(rejected).toEqual(['bestOf', 'patience']);
  });

  it('names an unknown decoding key by its dotted path', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { beamSize: 5, bestOf: 5 } });
    expect(profile.decoding).toEqual({ beamSize: 5 });
    expect(rejected).toEqual(['decoding.bestOf']);
  });

  it('names a decoding block that is not an object at all', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: 'beamSize=5' });
    expect(profile).toEqual({});
    expect(rejected).toEqual(['decoding']);
  });

  it('reports rejections in a stable order so a log line does not churn', () => {
    // Declared members first, in DECLARATION order (so `decoding.*` precedes the
    // top-level unknowns whatever the JSON key order was), then the unknown keys
    // in the order the row wrote them.
    const { rejected } = parseAiModelAsrProfile({ zzz: 1, decoding: { zzz: 1, beamSize: 99 }, aaa: 1 });
    expect(rejected).toEqual(['decoding.beamSize', 'decoding.zzz', 'zzz', 'aaa']);
  });
});
