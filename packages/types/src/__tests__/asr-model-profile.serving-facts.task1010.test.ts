/**
 * TASK-1010 phase B (OD-6 / OD-8) — the two SERVING facts an `AiModel` row carries on
 * `_metadata.asr`: `quantization` (how the weights on this row are quantised) and
 * `maxModelLen` (the decoder context the serving engine is sized for).
 *
 * They are facts about the WEIGHTS, so they live on the row beside the decode profile and
 * ride the same shape-only parser: a valid value is kept, an unknown or out-of-range one is
 * DROPPED and NAMED in `rejected` — never thrown, never forwarded to a runtime whose mirror
 * is `extra='forbid'`.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_MODEL_ASR_PROFILE_QUANTIZATIONS,
  AI_MODEL_ASR_PROFILE_SERVING_RANGES,
  parseAiModelAsrProfile,
} from '../asr-model-profile.js';

describe('parseAiModelAsrProfile — serving facts (TASK-1010)', () => {
  it('publishes the closed quantization vocabulary and the maxModelLen range', () => {
    expect([...AI_MODEL_ASR_PROFILE_QUANTIZATIONS]).toEqual(['none', 'fp8', 'awq', 'gptq', 'int8']);
    expect(AI_MODEL_ASR_PROFILE_SERVING_RANGES.maxModelLen).toMatchObject({ min: 1, integer: true });
  });

  it.each(['none', 'fp8', 'awq', 'gptq', 'int8'])('keeps quantization %s', (quantization) => {
    const { profile, rejected } = parseAiModelAsrProfile({ quantization });
    expect(rejected).toEqual([]);
    expect(profile).toEqual({ quantization });
  });

  it('keeps a whole maxModelLen of at least 1 (the Whisper decoder context is 448)', () => {
    for (const maxModelLen of [1, 448, 32768]) {
      const { profile, rejected } = parseAiModelAsrProfile({ maxModelLen });
      expect(rejected).toEqual([]);
      expect(profile).toEqual({ maxModelLen });
    }
  });

  it('reads both beside the decode profile without disturbing it', () => {
    const { profile, rejected } = parseAiModelAsrProfile({ maxDecodeWindowSec: 7, quantization: 'none', maxModelLen: 448 });
    expect(rejected).toEqual([]);
    expect(profile).toEqual({ maxDecodeWindowSec: 7, quantization: 'none', maxModelLen: 448 });
  });

  it.each([['FP8'], ['bf16'], [''], [8], [true], [null]])('drops and names an unknown quantization %j', (quantization) => {
    const { profile, rejected } = parseAiModelAsrProfile({ quantization });
    expect(profile).not.toHaveProperty('quantization');
    expect(rejected).toEqual(['quantization']);
  });

  it.each([[0], [-1], [2.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['448'], [null]])('drops and names an invalid maxModelLen %j', (maxModelLen) => {
    const { profile, rejected } = parseAiModelAsrProfile({ maxModelLen });
    expect(profile).not.toHaveProperty('maxModelLen');
    expect(rejected).toEqual(['maxModelLen']);
  });

  it('treats both as KNOWN keys, so neither is reported as unknown', () => {
    const { rejected } = parseAiModelAsrProfile({ quantization: 'fp8', maxModelLen: 448, bestOf: 5 });
    expect(rejected).toEqual(['bestOf']);
  });

  it('reports rejections in declaration order, before unknown keys', () => {
    const { rejected } = parseAiModelAsrProfile({ zzz: 1, maxModelLen: 0, quantization: 'q4', maxDecodeWindowSec: 99 });
    expect(rejected).toEqual(['maxDecodeWindowSec', 'quantization', 'maxModelLen', 'zzz']);
  });
});
