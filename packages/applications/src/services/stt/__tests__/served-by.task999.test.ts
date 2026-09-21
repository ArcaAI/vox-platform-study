/**
 * TASK-999 (D-6(a)) — `resolveServedBy`: which chain entry ACTUALLY served.
 *
 * RED before the change: `served-by.ts` did not exist. Nothing anywhere recorded
 * which entry of `resolvedSpec.fallback.chain` ran — the chain is a snapshot of
 * what COULD run, and the engine name alone cannot tell a primary from a fallback
 * that shares its provider.
 */
import { describe, expect, it } from 'vitest';
import { resolveServedBy } from '../served-by';

/* eslint-disable @typescript-eslint/no-explicit-any */
const core = (agentSlug: string, modelSlug: string, provider: string | null, libraryName?: string): any => ({
  runtimeKey: `${agentSlug}:${modelSlug}`,
  agent: { slug: agentSlug, versionId: `${agentSlug}-v1`, versionNumber: 1, tenantId: 't-1', source: 'tenant' },
  models: { asr: { role: 'asr', slug: modelSlug, taskType: 'SPEECH_TO_TEXT', format: 'GGUF', provider, libraryName } },
});

const spec = (primary: any, chain: any[] = []): any => ({
  ...primary,
  schemaVersion: 1,
  fallback: { kind: chain.length > 0 ? 'model' : 'none', autoSwitch: true, switchAfterConsecutiveFailures: 3, chain, spec: chain[0] ?? null },
});

describe('TASK-999 — resolveServedBy', () => {
  it('names the PRIMARY when the engine that served identifies as the resolved spec', () => {
    const served = resolveServedBy(spec(core('ml-en-consult', 'whisper-ml-en-f16', null, 'whisper.cpp')), 'whisper_cpp');

    expect(served).toEqual({
      // The primary is not a member of `fallback.chain`, so there is no index
      // into that array to give — `source` is what says which entry ran.
      chainIndex: -1,
      source: 'primary',
      agentSlug: 'ml-en-consult',
      modelSlug: 'whisper-ml-en-f16',
      provider: null,
      engine: 'whisper_cpp',
    });
  });

  it('names the FALLBACK and its chain index when a non-primary engine served', () => {
    const served = resolveServedBy(
      spec(core('ml-en-consult', 'whisper-ml-en-f16', null, 'whisper.cpp'), [
        core('ml-en-consult', 'whisper-ml-en-q8', null, 'faster-whisper'),
        core('cloud-fallback', 'sarvam-saarika-v2', 'sarvam'),
      ]),
      'sarvam',
    );

    expect(served).toMatchObject({ chainIndex: 1, source: 'fallback', agentSlug: 'cloud-fallback', modelSlug: 'sarvam-saarika-v2', provider: 'sarvam' });
  });

  it('matches across the separator spellings the ledger and the registry disagree on', () => {
    // `AiModel.libraryName` says `faster-whisper`; the ledger's engine vocabulary
    // says `faster_whisper`. Same engine, and a chain entry must not go unmatched
    // over a hyphen.
    const served = resolveServedBy(
      spec(core('a', 'primary-model', null, 'whisper.cpp'), [core('a', 'fallback-model', null, 'faster-whisper')]),
      'faster_whisper',
    );

    expect(served).toMatchObject({ chainIndex: 0, source: 'fallback', modelSlug: 'fallback-model' });
  });

  it('records what it knows, and nothing it does not, when the engine matches no entry', () => {
    const served = resolveServedBy(spec(core('a', 'primary-model', null, 'whisper.cpp')), 'some_engine_we_never_declared');

    // `chainIndex: -1` with no agent/model: the engine provably is not the
    // primary, but WHICH fallback it was is unknown. Guessing an entry here would
    // put a wrong model on a billing-adjacent row.
    expect(served).toEqual({
      chainIndex: -1,
      source: 'fallback',
      agentSlug: null,
      modelSlug: null,
      provider: null,
      engine: 'some_engine_we_never_declared',
    });
  });

  it('is null — "not recorded" — when there is no spec or no engine to place in it', () => {
    // RED before the change: nothing existed to return null. `null` has to stay
    // distinguishable from a recorded-but-unmatched entry, which is the case above.
    expect(resolveServedBy(null, 'whisper_cpp')).toBeNull();
    expect(resolveServedBy(spec(core('a', 'm', null, 'whisper.cpp')), null)).toBeNull();
    expect(resolveServedBy(spec(core('a', 'm', null, 'whisper.cpp')), '')).toBeNull();
  });
});
