/**
 * `model-meta` vocabulary + derivation helpers. TASK-960 adds the `S3` source
 * (D3) and the LOCAL-row helpers that keep `sourceUri` from disagreeing with
 * `bucketPrefix` (D3c), plus the client-side mirror of the gateway's
 * bucket-relative `bucketPrefix` validation (D2/Lane B).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MODEL_TASK_TYPE_OPTIONS,
  SERVED_BY_OPTIONS,
  SOURCE_LABELS,
  SOURCE_OPTIONS,
  taskTypeToPipelineTag,
} from '../model-meta';

describe('SOURCE_OPTIONS / SOURCE_LABELS (TASK-1023)', () => {
  it('offers only the three registration sources — GITHUB and S3 are no longer offered', () => {
    expect(SOURCE_OPTIONS).toEqual(['HUGGINGFACE', 'MLFLOW', 'LOCAL']);
  });

  it('keeps a human label for every source, including the retired ones existing rows still carry', () => {
    for (const option of [...SOURCE_OPTIONS, 'GITHUB', 'S3'] as const) {
      expect(SOURCE_LABELS[option]).toBeTruthy();
    }
    expect(SOURCE_LABELS.S3).toBe('S3 bucket');
  });
});

/**
 * The console cannot import `@arcaai/domains` / `@arcaai/applications`, so the
 * dropdown vocabularies are copies. These read the gateway's sources and fail
 * on drift: a value missing here cannot be chosen; one extra here is a 400.
 */
const REPO_ROOT = new URL('../../../../../../../', import.meta.url);

describe('dropdown vocabularies mirror the gateway DTO', () => {
  it('MODEL_TASK_TYPE_OPTIONS is exactly the ModelTaskType enum', () => {
    const source = readFileSync(new URL('packages/domains/src/enums/generated/ModelTaskType.ts', REPO_ROOT), 'utf8');
    const enumValues = [...source.matchAll(/=\s*'([A-Z0-9_]+)'/g)].map((match) => match[1]);
    expect(enumValues.length).toBeGreaterThan(40);
    expect([...MODEL_TASK_TYPE_OPTIONS].sort()).toEqual([...enumValues].sort());
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
