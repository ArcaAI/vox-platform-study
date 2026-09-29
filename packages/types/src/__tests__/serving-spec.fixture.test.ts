/**
 * TASK-1021 (C-1) — `ResolvedServingSpec`: the committed cross-language fixture is the lock.
 * `apps/vllm`'s pydantic mirror parses the SAME file, so a drift on either side fails a suite.
 */
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/contracts/resolved-serving-spec.fixture.json';
import { isResolvedServingSpec } from '../serving-spec.js';

describe('ResolvedServingSpec — the committed fixture (TASK-1021 C-1)', () => {
  it('the committed fixture is a valid ResolvedServingSpec', () => {
    expect(isResolvedServingSpec(fixture)).toBe(true);
  });

  it('rejects a spec without engine.vramGiB', () => {
    expect(isResolvedServingSpec({ ...fixture, engine: { maxNumSeqs: 1, enforceEager: null } })).toBe(false);
  });

  it.each([
    [
      'a missing key',
      (spec: Record<string, unknown>) => {
        delete spec.sourceRevision;
      },
    ],
    [
      'an unknown kind',
      (spec: Record<string, unknown>) => {
        spec.kind = 'video';
      },
    ],
    [
      'a non-SAFETENSOR format',
      (spec: Record<string, unknown>) => {
        spec.format = 'WHISPER_CPP';
      },
    ],
    [
      'an unknown computeType',
      (spec: Record<string, unknown>) => {
        spec.computeType = 'int8';
      },
    ],
    [
      'an unknown quantization',
      (spec: Record<string, unknown>) => {
        spec.quantization = 'q4';
      },
    ],
    [
      'a string maxModelLen',
      (spec: Record<string, unknown>) => {
        spec.maxModelLen = '448';
      },
    ],
    [
      'a non-positive vramGiB',
      (spec: Record<string, unknown>) => {
        spec.engine = { vramGiB: 0, maxNumSeqs: null, enforceEager: null };
      },
    ],
    [
      'a string enforceEager',
      (spec: Record<string, unknown>) => {
        spec.engine = { vramGiB: 5, maxNumSeqs: null, enforceEager: 'yes' };
      },
    ],
    [
      'an extra top-level key',
      (spec: Record<string, unknown>) => {
        spec.apiKey = 'x';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const spec = structuredClone(fixture) as Record<string, unknown>;
    mutate(spec);
    expect(isResolvedServingSpec(spec)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isResolvedServingSpec(null)).toBe(false);
    expect(isResolvedServingSpec([])).toBe(false);
  });
});
