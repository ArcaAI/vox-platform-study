import { describe, expect, it } from 'vitest';
import { matchesRuntimeKey, normalizeRuntimeKey, rankRuntimeKeyCandidates, runtimeKeysFor } from '../runtime-key';

/**
 * TASK-1051 F1 — LM Studio reports `models[].key` with its quantisation suffix
 * (`gemma-4-e2b-it-qat@q4_0`) while the catalogue holds `wireModelId`
 * (`gemma-4-e2b-it-qat`); an exact string compare left a 57-agent live-path
 * model "not loaded" next to an orphan row for the same instance.
 */
describe('normalizeRuntimeKey', () => {
  it('strips the LM Studio quantisation and instance suffixes', () => {
    expect(normalizeRuntimeKey('lm-studio', 'gemma-4-e2b-it-qat@q4_0')).toBe('gemma-4-e2b-it-qat');
    expect(normalizeRuntimeKey('lm-studio', 'granite-guardian-4.1-8b:2')).toBe('granite-guardian-4.1-8b');
    expect(normalizeRuntimeKey('lm-studio', 'Qwen/Qwen3-8B-GGUF@Q8_0:3')).toBe('qwen/qwen3-8b-gguf');
  });

  it('is the identity for every other service', () => {
    expect(normalizeRuntimeKey('stt', 'radiology-asr-en')).toBe('radiology-asr-en');
    expect(normalizeRuntimeKey('nlp', 'blaze999/Medical-NER')).toBe('blaze999/Medical-NER');
  });
});

describe('runtimeKeysFor', () => {
  it('is the catalogue ref plus every operator-confirmed key, de-duplicated', () => {
    const model = {
      slug: 'lms-gemma-4-e2b-it-qat',
      sourceUri: 'lmstudio://gemma',
      wireModelId: 'gemma-4-e2b-it-qat',
      metaData: { residency: { runtimeKeys: ['gemma-4-e2b-it-qat@q4_0', 'gemma-4-e2b-it-qat'] } },
    };
    expect(runtimeKeysFor('lm-studio', model)).toEqual(['gemma-4-e2b-it-qat', 'gemma-4-e2b-it-qat@q4_0']);
  });

  it('ignores a malformed _metadata', () => {
    expect(runtimeKeysFor('stt', { slug: 'a', sourceUri: 'x', metaData: { residency: { runtimeKeys: 'nope' } } })).toEqual(['a']);
    expect(runtimeKeysFor('stt', { slug: 'a', sourceUri: 'x', metaData: null })).toEqual(['a']);
  });
});

describe('matchesRuntimeKey', () => {
  const gemma = { slug: 'lms-gemma-4-e2b-it-qat', sourceUri: 'x', wireModelId: 'gemma-4-e2b-it-qat' };

  it('matches a suffixed LM Studio key to its bare wire id', () => {
    expect(matchesRuntimeKey('lm-studio', gemma, 'gemma-4-e2b-it-qat@q4_0')).toBe(true);
  });

  it('never matches a different model of the same family', () => {
    expect(matchesRuntimeKey('lm-studio', gemma, 'gemma-4-e4b-it-qat@q4_0')).toBe(false);
  });

  it('matches an operator-confirmed key exactly, even when normalisation would not', () => {
    const aliased = { ...gemma, metaData: { residency: { runtimeKeys: ['google/gemma-e2b-custom'] } } };
    expect(matchesRuntimeKey('lm-studio', aliased, 'google/gemma-e2b-custom')).toBe(true);
  });

  it('stays exact for stt and nlp', () => {
    expect(matchesRuntimeKey('stt', { slug: 'radiology-asr-en', sourceUri: 'x' }, 'radiology-asr-en')).toBe(true);
    expect(matchesRuntimeKey('stt', { slug: 'radiology-asr-en', sourceUri: 'x' }, 'radiology-asr-en@q8')).toBe(false);
  });
});

describe('rankRuntimeKeyCandidates', () => {
  const rows = [
    { id: '1', name: 'Gemma 4 E2B IT QAT', slug: 'lms-gemma-4-e2b-it-qat', sourceUri: 'x', wireModelId: 'gemma-4-e2b-it-qat' },
    { id: '2', name: 'Gemma 4 E4B IT QAT', slug: 'lms-gemma-4-e4b', sourceUri: 'x', wireModelId: 'gemma-4-e4b-it-qat' },
    { id: '3', name: 'Granite Guardian', slug: 'granite', sourceUri: 'x', wireModelId: 'granite-guardian-4.1-8b' },
  ];

  it('ranks the normalised match strong and a same-family row weak, and drops unrelated rows', () => {
    const ranked = rankRuntimeKeyCandidates('lm-studio', 'gemma-4-e2b-it-qat@q4_0', rows);
    expect(ranked.map((c) => [c.aiModelId, c.strength])).toEqual([
      ['1', 'strong'],
      ['2', 'weak'],
    ]);
    expect(ranked[0].reason).toMatch(/suffix/i);
  });
});
