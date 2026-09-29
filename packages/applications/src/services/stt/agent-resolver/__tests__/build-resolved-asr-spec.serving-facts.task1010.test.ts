/**
 * TASK-1010 phase B (OD-6 / OD-8) — the two SERVING facts a registry row declares on
 * `_metadata.asr` (`quantization`, `maxModelLen`) reach the ASR wire as top-level, OPTIONAL
 * `AsrSpecModel` fields: emitted when the row states them, OMITTED (never `null`) when it does
 * not, so an `extra='forbid'` consumer and the gateway can deploy in either order.
 *
 * Selection is untouched: the model is still whatever the AGENT binds; these are facts ABOUT
 * that model, read off its own row.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedAgent, ResolvedAgentModel, ResolvedAsrSpec } from '@arcaai/types';
import { describe, expect, it } from 'vitest';
import { type AsrProfileRejection, buildResolvedAsrSpec } from '../build-resolved-asr-spec';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
  expected: ResolvedAsrSpec;
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureCase | string>;
const base = (fixture.platformDefault as FixtureCase).input.agent;

/** `platformDefault` with its PRIMARY row's `_metadata.asr` replaced by `asr` (fallback rows untouched). */
function withPrimaryAsr(asr: Record<string, unknown> | undefined): ResolvedAgent {
  return {
    ...base,
    models: base.models.map((model): ResolvedAgentModel => {
      if (model.role !== 'primary') return model;
      const { metaData: _drop, ...rest } = model;
      return asr === undefined ? rest : { ...rest, metaData: { asr } as ResolvedAgentModel['metaData'] };
    }),
  };
}

describe('toSpecModel — serving facts (TASK-1010)', () => {
  it('emits quantization and maxModelLen on the ASR model when the row declares them', () => {
    const spec = buildResolvedAsrSpec({ agent: withPrimaryAsr({ quantization: 'fp8', maxModelLen: 448 }) });
    expect(spec.models.asr.quantization).toBe('fp8');
    expect(spec.models.asr.maxModelLen).toBe(448);
  });

  it('keeps them OUT of `metadata` — they are serving facts, not the decode profile', () => {
    const spec = buildResolvedAsrSpec({ agent: withPrimaryAsr({ maxDecodeWindowSec: 7, quantization: 'none', maxModelLen: 448 }) });
    expect(spec.models.asr.metadata).toEqual({ maxDecodeWindowSec: 7 });
    expect(spec.models.asr).toMatchObject({ quantization: 'none', maxModelLen: 448 });
  });

  it('omits both (never null) when the row declares neither', () => {
    for (const asr of [undefined, { maxDecodeWindowSec: 7 }]) {
      const spec = buildResolvedAsrSpec({ agent: withPrimaryAsr(asr) });
      expect(spec.models.asr).not.toHaveProperty('quantization');
      expect(spec.models.asr).not.toHaveProperty('maxModelLen');
    }
  });

  it('emits one without the other', () => {
    const spec = buildResolvedAsrSpec({ agent: withPrimaryAsr({ maxModelLen: 448 }) });
    expect(spec.models.asr.maxModelLen).toBe(448);
    expect(spec.models.asr).not.toHaveProperty('quantization');
  });

  it('drops an invalid value from the wire and REPORTS it rather than forwarding it', () => {
    const rejections: AsrProfileRejection[] = [];
    const spec = buildResolvedAsrSpec({
      agent: withPrimaryAsr({ quantization: 'q4_k_m', maxModelLen: 0 }),
      onProfileRejection: (rejection) => rejections.push(rejection),
    });
    expect(spec.models.asr).not.toHaveProperty('quantization');
    expect(spec.models.asr).not.toHaveProperty('maxModelLen');
    expect(rejections).toContainEqual({ modelSlug: 'arcaai-whisper-large-ml-en-gguf', rejected: ['quantization', 'maxModelLen'] });
  });

  it('carries each chain row`s OWN facts — a fallback row never inherits the primary`s', () => {
    const spec = buildResolvedAsrSpec({ agent: withPrimaryAsr({ quantization: 'fp8', maxModelLen: 448 }) });
    const fallbackAsr = spec.fallback.chain[0]?.models.asr;
    expect(fallbackAsr).toBeDefined();
    expect(fallbackAsr).not.toHaveProperty('quantization');
    expect(fallbackAsr).not.toHaveProperty('maxModelLen');
  });
});
