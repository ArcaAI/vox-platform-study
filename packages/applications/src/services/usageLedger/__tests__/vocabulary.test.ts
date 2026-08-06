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

import { KNOWN_PROVIDERS, USAGE_OPERATIONS, isKnownProvider, isUsageOperation, validateProviderId } from '../vocabulary';
import { UsageIdempotencyKey, validateIdempotencyKey } from '../idempotency-keys';

describe('operation vocabulary', () => {
  it('freezes exactly the ten operations wave-1 emitters may use', () => {
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
      ].sort(),
    );
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
    for (const provider of ['openai', 'azure', 'azure-speech', 'anthropic', 'bedrock', 'vertex', 'sarvam', 'ollama', 'lm-studio', 'vllm', 'llama-cpp']) {
      expect(isKnownProvider(provider)).toBe(true);
    }
  });

  it('carries the self-hosted engine ids the Python services report', () => {
    for (const engine of ['whisper_cpp', 'faster_whisper', 'kokoro', 'indic_parler', 'silero', 'gliner']) {
      expect(isKnownProvider(engine)).toBe(true);
    }
  });

  it('does not carry the spellings that are NOT in the seed', () => {
    // `azure-openai` is the SMR settings value; the CONNECTION id is `azure`.
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
