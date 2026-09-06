/**
 * TASK-890 L1 — `localPath` stops being a COLUMN and becomes a DERIVATION (§3.11).
 *
 * The Python resolvers keep reading `local_path` off the resolved specs, so the
 * VALUE may not change; only its source may. This pins that: what
 * `derivedLocalPath(row)` returns is byte-for-byte what the publish processor
 * used to write into the column, for both layouts.
 */
import { describe, it, expect } from 'vitest';
import { deriveLocalPath, derivedLocalPath } from '../constants';

const SINGLE_FILE = { bucketPrefix: 'whisper-large-v3/1.0.0', primaryObject: 'ggml-large-v3.bin', libraryName: 'whisper.cpp' };
const DIRECTORY = { bucketPrefix: 'hf/hub/models--google--gemma/snapshots/abc123', primaryObject: 'model.safetensors', libraryName: 'transformers' };

describe('TASK-890 derivedLocalPath', () => {
  it('reproduces what the publish processor wrote for a single-file loader', () => {
    expect(derivedLocalPath(SINGLE_FILE)).toBe(deriveLocalPath(SINGLE_FILE.bucketPrefix, SINGLE_FILE.primaryObject));
    expect(derivedLocalPath(SINGLE_FILE)).toBe('/mnt/models-bucket/whisper-large-v3/1.0.0/ggml-large-v3.bin');
  });

  it('reproduces the DIRECTORY form for a multi-file loader, even though the row names a primary object', () => {
    expect(derivedLocalPath(DIRECTORY)).toBe('/mnt/models-bucket/hf/hub/models--google--gemma/snapshots/abc123/');
  });

  it('is null for a row with no bucket identity, so scheme dispatch on `sourceUri` resumes downstream', () => {
    expect(derivedLocalPath({ bucketPrefix: null, primaryObject: null })).toBeNull();
    expect(derivedLocalPath({ bucketPrefix: undefined, primaryObject: undefined })).toBeNull();
    expect(derivedLocalPath(null)).toBeNull();
  });

  it('never consults a stored `localPath` — the column is going away', () => {
    const row = { bucketPrefix: null, primaryObject: null, localPath: '/mnt/models-bucket/stale/path' };
    expect(derivedLocalPath(row)).toBeNull();
  });
});
