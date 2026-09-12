/**
 * `model-meta` vocabulary + derivation helpers. TASK-960 adds the `S3` source
 * (D3) and the LOCAL-row helpers that keep `sourceUri` from disagreeing with
 * `bucketPrefix` (D3c), plus the client-side mirror of the gateway's
 * bucket-relative `bucketPrefix` validation (D2/Lane B).
 */

import { describe, expect, it } from 'vitest';
import { deriveLocalSourceUri, isBucketPrefixRedundant, SOURCE_LABELS, SOURCE_OPTIONS } from '../model-meta';

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
