/**
 * `model-meta` vocabulary + derivation helpers. TASK-960 adds the `S3` source
 * (D3) and the LOCAL-row helpers that keep `sourceUri` from disagreeing with
 * `bucketPrefix` (D3c), plus the client-side mirror of the gateway's
 * bucket-relative `bucketPrefix` validation (D2/Lane B).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveLocalSourceUri,
  isBucketPrefixRedundant,
  MODEL_TASK_TYPE_OPTIONS,
  RUNTIME_PROVIDER_OPTIONS,
  SERVED_BY_OPTIONS,
  SOURCE_LABELS,
  SOURCE_OPTIONS,
  taskTypeToPipelineTag,
} from '../model-meta';

describe('SOURCE_OPTIONS / SOURCE_LABELS — S3 (TASK-960 D3)', () => {
  it('offers S3 alongside the existing sources', () => {
    expect(SOURCE_OPTIONS).toContain('S3');
    expect(SOURCE_OPTIONS).toEqual(['HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL', 'S3']);
  });

  it('has a human label for every option, S3 included', () => {
    for (const option of SOURCE_OPTIONS) {
      expect(SOURCE_LABELS[option]).toBeTruthy();
    }
    expect(SOURCE_LABELS.S3).toBe('S3 bucket');
  });
});

describe('deriveLocalSourceUri (TASK-960 D3c)', () => {
  it('derives s3://hope-models/<prefix> from a bucket-relative prefix', () => {
    expect(deriveLocalSourceUri('arcaai-whisper-en-2609/')).toBe('s3://hope-models/arcaai-whisper-en-2609');
    expect(deriveLocalSourceUri('whisper-large-v4/q4-0-451faffb5a16/')).toBe('s3://hope-models/whisper-large-v4/q4-0-451faffb5a16');
  });

  it('trims surrounding whitespace and slashes', () => {
    expect(deriveLocalSourceUri('  /medical-ner/abc/  ')).toBe('s3://hope-models/medical-ner/abc');
  });

  it('is empty until a bucket prefix is entered', () => {
    expect(deriveLocalSourceUri('')).toBe('');
    expect(deriveLocalSourceUri('   ')).toBe('');
  });
});

describe('isBucketPrefixRedundant (TASK-960 D2, mirrors the gateway DTO validator)', () => {
  it('rejects a prefix that repeats the bucket name', () => {
    expect(isBucketPrefixRedundant('hope-models/arcaai-whisper-en-2609')).toBe(true);
    expect(isBucketPrefixRedundant('hope-models')).toBe(true);
  });

  it('rejects a prefix that repeats the s3:// scheme + bucket', () => {
    expect(isBucketPrefixRedundant('s3://hope-models/arcaai-whisper-en-2609')).toBe(true);
    expect(isBucketPrefixRedundant('s3://hope-models')).toBe(true);
  });

  it('is case-insensitive, matching the evidence row (mixed case would still double the path)', () => {
    expect(isBucketPrefixRedundant('Hope-Models/x')).toBe(true);
  });

  it('accepts a bucket-relative prefix', () => {
    expect(isBucketPrefixRedundant('arcaai-whisper-en-2609/')).toBe(false);
    expect(isBucketPrefixRedundant('whisper-large-v4/q4-0-451faffb5a16/')).toBe(false);
  });

  it('is false for an empty value — required-ness is a separate concern', () => {
    expect(isBucketPrefixRedundant('')).toBe(false);
    expect(isBucketPrefixRedundant('   ')).toBe(false);
  });
});

/**
 * The console cannot import `@arcaai/domains` / `@arcaai/applications`, so the
 * dropdown vocabularies are copies. These read the gateway's sources and fail
 * on drift: a value missing here cannot be chosen; one extra here is a 400.
 */
const REPO_ROOT = new URL('../../../../../../../', import.meta.url);

function sourceArray(relativePath: string, constName: string): string[] {
  const source = readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
  const body = source.match(new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`))?.[1] ?? '';
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('dropdown vocabularies mirror the gateway DTO', () => {
  it('MODEL_TASK_TYPE_OPTIONS is exactly the ModelTaskType enum', () => {
    const source = readFileSync(new URL('packages/domains/src/enums/generated/ModelTaskType.ts', REPO_ROOT), 'utf8');
    const enumValues = [...source.matchAll(/=\s*'([A-Z0-9_]+)'/g)].map((match) => match[1]);
    expect(enumValues.length).toBeGreaterThan(40);
    expect([...MODEL_TASK_TYPE_OPTIONS].sort()).toEqual([...enumValues].sort());
  });

  it('RUNTIME_PROVIDER_OPTIONS is exactly AI_MODEL_PROVIDERS', () => {
    const providers = sourceArray('packages/applications/src/services/ai-model/constants.ts', 'AI_MODEL_PROVIDERS');
    expect(providers).toContain('azure-speech');
    expect([...RUNTIME_PROVIDER_OPTIONS].sort()).toEqual([...providers].sort());
  });
});

describe('taskTypeToPipelineTag', () => {
  it('renders the enum member as the Hugging Face pipeline tag', () => {
    expect(taskTypeToPipelineTag('AUTOMATIC_SPEECH_RECOGNITION')).toBe('automatic-speech-recognition');
    expect(taskTypeToPipelineTag('TEXT2TEXT_GENERATION')).toBe('text2text-generation');
  });
});

describe('SERVED_BY_OPTIONS — the vllm serving target (TASK-1021 D-13)', () => {
  it('offers vllm, and no longer the retired asr-vllm name', () => {
    expect(SERVED_BY_OPTIONS).toContain('vllm');
    expect(SERVED_BY_OPTIONS).not.toContain('asr-vllm');
  });
});
