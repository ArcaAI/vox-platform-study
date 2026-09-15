/**
 * Frozen operation / provider vocabulary + idempotency-key recipes.
 *
 * These strings become rollup dimensions and dashboard facets. `azure` and
 * `Azure` are two providers to Postgres and one provider to a human, so the
 * split shows up as a halved cost figure nobody can explain — the shape rules
 * below exist to make that impossible rather than to be tidy.
 */

import { describe, expect, it } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';

import {
  KNOWN_PROVIDERS,
  SELF_HOSTED_PROVIDER_IDS,
  USAGE_OPERATIONS,
  isKnownProvider,
  isUsageOperation,
  validateProviderId,
} from '../vocabulary';
import { UsageIdempotencyKey, validateIdempotencyKey } from '../idempotency-keys';

describe('operation vocabulary', () => {
  it('freezes exactly the fifteen operations the emitters may use', () => {
    expect([...USAGE_OPERATIONS].sort()).toEqual(
      [
        'transcribe.stream',
        'transcribe.batch',
        'generate',
        'generate.stream',
        'presummarize',
        'guardrail.validate',
        'ner.extract',
        'tts.synthesize',
        'harness.step',
        'embed',
        // TASK-959 W0 (§10.2) — the durable worker's own compute and the
        // nightly storage snapshot are BILLING rows on operations nothing else
        // emits, so both had to enter the closed list before their emitters
        // could be written.
        'workflow.step',
        'storage.snapshot',
        // TASK-957 F-7b — the NLP plane's SECOND operation. `ner.extract` is
        // entity extraction; the diagnosis/topic/intent benches are
        // classification, and they were emitting nothing at all. Kept apart
        // from `ner.extract` because they are different work at different
        // prices and "spend by activity" cannot separate them afterwards.
        'nlp.classify',
        // TASK-974 §9.2 (D-5) — the DNA writing-style plane: the analyst's own
        // LLM call, and the ingest API call that decides whether one happens.
        'dna.analyze',
        'dna.ingest',
      ].sort(),
    );
  });

  it('carries `nlp.classify` under its exact spelling (TASK-957 F-7b)', () => {
    // A typo does not fail — it silently forks a rollup dimension, and the
    // classification benches would land under an operation no invoice sums.
    expect(isUsageOperation('nlp.classify')).toBe(true);
    expect(isUsageOperation('nlp_classify')).toBe(false);
    expect(isUsageOperation('nlp.Classify')).toBe(false);
  });

  it('carries the two TASK-959 operations under their exact spellings', () => {
    // A typo here does not fail — it silently forks a rollup dimension, and a
    // workflow's worker CPU would land under an operation no invoice sums.
    expect(isUsageOperation('workflow.step')).toBe(true);
    expect(isUsageOperation('storage.snapshot')).toBe(true);
    expect(isUsageOperation('workflow_step')).toBe(false);
    expect(isUsageOperation('storage.Snapshot')).toBe(false);
  });

  it('recognises a member and rejects a near-miss', () => {
    expect(isUsageOperation('transcribe.batch')).toBe(true);
    // A typo here would silently create an eleventh operation nobody rolls up.
    expect(isUsageOperation('transcribe.Batch')).toBe(false);
    expect(isUsageOperation('summarize')).toBe(false);
    expect(isUsageOperation(42)).toBe(false);
  });
});

describe('provider vocabulary', () => {
  it('carries the connection ids the AiProviderConnection seed already uses', () => {
    for (const provider of [
      'openai',
      'azure',
      'azure-speech',
      'anthropic',
      'bedrock',
      'vertex',
      'sarvam',
      'ollama',
      'lm-studio',
      'vllm',
      'llama-cpp',
      // TASK-957 F-9 — TASK-952/E minted this provider id for the platform
      // embeddings tier and registered it nowhere here, so the next self-hosted
      // emitter to name it would have classified it CLOUD.
      'tei-embed',
    ]) {
      expect(isKnownProvider(provider)).toBe(true);
    }
  });

  it('carries `tei-embed` AND derives it self-hosted (TASK-957 F-9)', () => {
    expect(isKnownProvider('tei-embed')).toBe(true);
    // The platform runs the TEI server on its own hardware; classified CLOUD it
    // would bill an embeddings tier against a vendor nobody called.
    expect(SELF_HOSTED_PROVIDER_IDS.has('tei-embed')).toBe(true);
  });

  it('carries the self-hosted engine ids the Python services report', () => {
    for (const engine of [
      'whisper_cpp',
      'faster_whisper',
      // TASK-959 — both are reported by their services and both now carry a
      // GPU_SECOND COST row; an engine id missing here is an unshaped rollup
      // dimension the price book already depends on.
      'parakeet_cpp',
      'kokoro',
      'indic_parler',
      'indic_f5',
      'silero',
      'gliner',
    ]) {
      expect(isKnownProvider(engine)).toBe(true);
    }
  });

  it('does not carry the spellings that are NOT in the seed', () => {
    // `azure-openai` is the TEXT settings value; the CONNECTION id is `azure`.
    // Freezing the wrong one splits every LLM rollup in half.
    expect(isKnownProvider('azure-openai')).toBe(false);
    expect(isKnownProvider('lmstudio')).toBe(false);
    expect(isKnownProvider('llamacpp')).toBe(false);
    expect(isKnownProvider('whispercpp')).toBe(false);
  });

  it('accepts an UNKNOWN provider that is well-shaped — metering must never fail closed on a new connection', () => {
    // A tenant admin can add an AiProviderConnection at runtime. Rejecting its
    // usage would lose real money to protect a naming convention.
    expect(validateProviderId('some-new-vendor')).toEqual([]);
    expect(isKnownProvider('some-new-vendor')).toBe(false);
  });

  it('REJECTS a mis-shaped provider id', () => {
    expect(validateProviderId('Azure')).toHaveLength(1); // uppercase splits rollups
    expect(validateProviderId('azure openai')).toHaveLength(1); // whitespace
    expect(validateProviderId('')).toHaveLength(1);
    expect(validateProviderId('a'.repeat(65))).toHaveLength(1);
    expect(validateProviderId(null)).toHaveLength(1);
  });

  it('carries `harness` — the durable worker is a self-hosted engine that bills its own CPU (TASK-959 §3.4)', () => {
    expect(isKnownProvider('harness')).toBe(true);
    // And it must be DERIVABLE as self-hosted, or every `WORKFLOW`/`CPU_SECOND`
    // row the interceptor emits would be classified CLOUD and billed against a
    // vendor that was never called.
    expect(SELF_HOSTED_PROVIDER_IDS.has('harness')).toBe(true);
  });

  it('keeps SELF_HOSTED_PROVIDER_IDS a strict subset of KNOWN_PROVIDERS', () => {
    for (const provider of SELF_HOSTED_PROVIDER_IDS) {
      expect(isKnownProvider(provider), provider).toBe(true);
    }
  });

  it('exposes the known set as data for the contract doc', () => {
    expect(KNOWN_PROVIDERS.length).toBeGreaterThan(10);
    expect(new Set(KNOWN_PROVIDERS).size).toBe(KNOWN_PROVIDERS.length);
  });
});

describe('idempotency-key recipes', () => {
  it('derives keys from INTENT — the same input always yields the same key', () => {
    expect(UsageIdempotencyKey.sttBatchJob('job-1')).toBe('stt:job:job-1');
    expect(UsageIdempotencyKey.sttBatchJob('job-1')).toBe(UsageIdempotencyKey.sttBatchJob('job-1'));

    expect(UsageIdempotencyKey.sttStreamSession('sess-1')).toBe('stt:session:sess-1');
    expect(UsageIdempotencyKey.llmRequest('req-1')).toBe('llm:req-1');
    expect(UsageIdempotencyKey.guardrailRequest('req-1')).toBe('guardrail:req-1');
    expect(UsageIdempotencyKey.ttsRequest('req-1')).toBe('tts:req-1');
    expect(UsageIdempotencyKey.nlpRequest('req-1')).toBe('nlp:req-1');
    expect(UsageIdempotencyKey.embedRequest('req-1')).toBe('embed:req-1');
    expect(UsageIdempotencyKey.harnessStep('step-1')).toBe('harness:step:step-1');
  });

  it('appends the unit to produce the per-row key documented in the contract', () => {
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.sttBatchJob('job-1'), AiUsageUnit.AUDIO_SECOND)).toBe('stt:job:job-1:AUDIO_SECOND');
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.sttStreamSession('s1'), AiUsageUnit.SESSION_SECOND)).toBe('stt:session:s1:SESSION_SECOND');
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.llmRequest('r1'), AiUsageUnit.INPUT_TOKEN)).toBe('llm:r1:INPUT_TOKEN');
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.ttsRequest('r1'), AiUsageUnit.CHARACTER)).toBe('tts:r1:CHARACTER');
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.harnessStep('st1'), AiUsageUnit.OUTPUT_TOKEN)).toBe('harness:step:st1:OUTPUT_TOKEN');
  });

  it('refuses to build a key from an empty or whitespace id', () => {
    // A blank id collapses every event of a capability onto one key, so the
    // FIRST one wins and every later one is silently discarded as a replay.
    expect(() => UsageIdempotencyKey.sttBatchJob('')).toThrow(/id/i);
    expect(() => UsageIdempotencyKey.llmRequest('  ')).toThrow(/id/i);
  });

  it('validates a key shape: non-empty, no whitespace, bounded', () => {
    expect(validateIdempotencyKey('llm:req-1:INPUT_TOKEN')).toEqual([]);
    expect(validateIdempotencyKey('')).toHaveLength(1);
    expect(validateIdempotencyKey('llm:req 1')).toHaveLength(1);
    expect(validateIdempotencyKey('x'.repeat(256))).toHaveLength(1);
    expect(validateIdempotencyKey(undefined)).toHaveLength(1);
  });
});
