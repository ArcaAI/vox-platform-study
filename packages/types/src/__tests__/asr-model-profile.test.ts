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
    // TASK-985 (QW-8/QW-9) — the whisper.cpp decode extras.
    ['entropyThreshold', 2.4, -0.1, 10.1],
    ['maxTokens', 32, -1, 225],
    ['audioCtx', 768, -1, 1501],
  ];

  it.each(decodingRanges)('decoding.%s accepts its range and rejects outside it', (key, ok, low, high) => {
    expect(parseAiModelAsrProfile({ decoding: { [key]: ok } }).profile.decoding).toEqual({ [key]: ok });
    for (const value of [low, high]) {
      const { profile, rejected } = parseAiModelAsrProfile({ decoding: { [key]: value } });
      expect(profile).not.toHaveProperty('decoding');
      expect(rejected).toEqual([`decoding.${key}`]);
    }
  });

  it.each(['beamSize', 'noRepeatNgramSize', 'prevTextContextWords', 'maxTokens', 'audioCtx'])('decoding.%s rejects a non-integer', (key) => {
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

describe('parseAiModelAsrProfile — decoding.hotwordsInPrompt (TASK-946 OD-1)', () => {
  // The TASK-937 R-4 switch: whether THIS model's engine may list `decoding.hotwords`
  // in its decoder prompt. It is a per-row property because the damage is per-row —
  // the seeded ml-en fine-tune decodes an English consultation 100 % Latin without the
  // append and 2 % Latin with it.
  it.each([true, false])('accepts an explicit %s', (value) => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { hotwordsInPrompt: value } });
    expect(profile.decoding).toEqual({ hotwordsInPrompt: value });
    expect(rejected).toEqual([]);
  });

  it('is absent when the row does not declare it — no opinion, not a false', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { hotwords: ['ceftriaxone'] } });
    expect(profile.decoding).toEqual({ hotwords: ['ceftriaxone'] });
    expect(profile.decoding).not.toHaveProperty('hotwordsInPrompt');
    expect(rejected).toEqual([]);
  });

  it('rejects a non-boolean rather than coercing it', () => {
    // A truthy string here would turn ON the one knob this ticket turned off, so it is
    // NAMED and dropped like every other bad value in a tuning block.
    for (const value of ['true', 1, null]) {
      const { profile, rejected } = parseAiModelAsrProfile({ decoding: { hotwordsInPrompt: value } });
      expect(profile).not.toHaveProperty('decoding');
      expect(rejected).toEqual(['decoding.hotwordsInPrompt']);
    }
  });

  it('is a KNOWN key, so it is never reported as an unknown one', () => {
    const { rejected } = parseAiModelAsrProfile({ decoding: { hotwordsInPrompt: true, bestOf: 5 } });
    expect(rejected).toEqual(['decoding.bestOf']);
  });
});

/**
 * TASK-985 (QW-8/QW-9) — the decode extras and the per-pass narrowing.
 *
 * Two things are being pinned here, and the second is the one that bites.
 *
 * 1. `entropyThreshold` is a SEPARATE key from `compressionRatioThreshold`. They share the
 *    default 2.4 and pywhispercpp's own schema comment calls one "similar to" the other, but
 *    OpenAI's gzip gate rejects text whose ratio is ABOVE the threshold while whisper.cpp's
 *    entropy gate rejects a distribution whose entropy is BELOW it — different quantities, on
 *    different scales, compared in opposite directions. Aliasing them would silently mean the
 *    opposite thing on every row that set one.
 * 2. `partial` / `final` are a strict SUBSET of the flat block, range-gated by the same table,
 *    and an unknown key inside them is named with its dotted path rather than swallowed.
 */
describe('parseAiModelAsrProfile — decode extras and per-pass blocks (TASK-985)', () => {
  it('keeps entropyThreshold and compressionRatioThreshold as two independent members', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { entropyThreshold: 2.6, compressionRatioThreshold: 2.4 } });
    expect(profile.decoding).toEqual({ compressionRatioThreshold: 2.4, entropyThreshold: 2.6 });
    expect(rejected).toEqual([]);
  });

  it.each(['singleSegment', 'suppressBlank', 'suppressNonSpeechTokens'])('decoding.%s is a boolean or nothing', (key) => {
    expect(parseAiModelAsrProfile({ decoding: { [key]: true } }).profile.decoding).toEqual({ [key]: true });
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { [key]: 'yes' } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual([`decoding.${key}`]);
  });

  it('reads a full per-pass narrowing on both passes', () => {
    const { profile, rejected } = parseAiModelAsrProfile({
      decoding: {
        logprobThreshold: -1,
        partial: { singleSegment: true, maxTokens: 32, audioCtx: 0 },
        final: { singleSegment: false, maxTokens: 0, logprobThreshold: -1.25, entropyThreshold: 2.6 },
      },
    });
    expect(rejected).toEqual([]);
    expect(profile.decoding).toEqual({
      logprobThreshold: -1,
      partial: { maxTokens: 32, audioCtx: 0, singleSegment: true },
      final: { logprobThreshold: -1.25, entropyThreshold: 2.6, maxTokens: 0, singleSegment: false },
    });
  });

  it('range-gates a per-pass member against the SAME table as the flat one, and names its dotted path', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { final: { maxTokens: 225 } } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual(['decoding.final.maxTokens']);
  });

  it('refuses a per-pass member the flat block has but a pass may not narrow', () => {
    // `conditionOnPrevTokens`, `noRepeatNgramSize`, `prevTextContextWords`,
    // `compressionRatioThreshold`, `hotwords` and `hotwordsInPrompt` are session- or
    // engine-level policy, not per-call kwargs: narrowing them per pass would promise
    // something no decoder can deliver, so they are UNKNOWN keys inside a pass block.
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { final: { conditionOnPrevTokens: true, hotwordsInPrompt: true } } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual(['decoding.final.conditionOnPrevTokens', 'decoding.final.hotwordsInPrompt']);
  });

  it('omits an all-rejected pass block rather than emitting an empty object', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { logprobThreshold: -1, partial: { maxTokens: 999 } } });
    expect(profile.decoding).toEqual({ logprobThreshold: -1 });
    expect(profile.decoding).not.toHaveProperty('partial');
    expect(rejected).toEqual(['decoding.partial.maxTokens']);
  });

  it('names a non-object pass block by its own path', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ decoding: { final: 'maxTokens=0' } });
    expect(profile).not.toHaveProperty('decoding');
    expect(rejected).toEqual(['decoding.final']);
  });

  it('treats `partial` and `final` as KNOWN keys, so they are never reported as unknown', () => {
    const { rejected } = parseAiModelAsrProfile({ decoding: { partial: { maxTokens: 32 }, final: { maxTokens: 0 }, bestOf: 5 } });
    expect(rejected).toEqual(['decoding.bestOf']);
  });
});
