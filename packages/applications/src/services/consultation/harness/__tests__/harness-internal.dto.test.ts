/**
 * HarnessProgressRequest DTO Validation Tests (TASK-348 — MAJ-6 / TG-3).
 *
 * The internal progress endpoint is service-token guarded, but a buggy or
 * compromised token-holder could still grow the per-consultation snapshot
 * unboundedly (rebroadcast to every SSE subscriber). These tests pin the
 * payload bounds enforced by class-validator at the validation pipe:
 *   - stage: known catalog + terminal pseudo-stages only, <= 128 chars
 *   - label / tenantId / jobId: <= 256 chars
 *   - ordinal / total: integers in [1, 50]
 *
 * Testing Strategy: REAL class-validator validate() — no mocks (mirrors
 * update-prompt-template.request.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  HARNESS_PROGRESS_FAILED_STAGE,
  HARNESS_PROGRESS_STAGE_KEYS,
  HARNESS_PROGRESS_TERMINAL_STAGE,
  HarnessProgressRequest,
} from '../dto';

async function validateDto(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(HarnessProgressRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

const VALID_EVENT = {
  tenantId: 'tenant-abc',
  jobId: 'harness-doc-1',
  stage: 'drafting_note',
  label: 'Drafting the note',
  ordinal: 3,
  total: 5,
};

describe('HarnessProgressRequest payload bounds (MAJ-6 / TG-3)', () => {
  it('accepts a well-formed catalog stage event', async () => {
    expect((await validateDto(VALID_EVENT)).isValid).toBe(true);
  });

  it('accepts every catalog stage plus both terminal pseudo-stages', async () => {
    for (const stage of [...HARNESS_PROGRESS_STAGE_KEYS, HARNESS_PROGRESS_TERMINAL_STAGE, HARNESS_PROGRESS_FAILED_STAGE]) {
      const result = await validateDto({ ...VALID_EVENT, stage });
      expect(result.isValid, `stage ${stage} should validate`).toBe(true);
    }
  });

  it('rejects an unknown stage key (fixed server-side catalog)', async () => {
    const result = await validateDto({ ...VALID_EVENT, stage: 'totally_unknown_stage' });
    expect(result.isValid).toBe(false);
  });

  it('rejects an over-length stage (> 128 chars)', async () => {
    const result = await validateDto({ ...VALID_EVENT, stage: 'x'.repeat(129) });
    expect(result.isValid).toBe(false);
  });

  it('rejects over-length label / tenantId / jobId (> 256 chars)', async () => {
    const oversized = 'y'.repeat(257);
    expect((await validateDto({ ...VALID_EVENT, label: oversized })).isValid).toBe(false);
    expect((await validateDto({ ...VALID_EVENT, tenantId: oversized })).isValid).toBe(false);
    expect((await validateDto({ ...VALID_EVENT, jobId: oversized })).isValid).toBe(false);
  });

  it('accepts boundary-length label (exactly 256 chars)', async () => {
    expect((await validateDto({ ...VALID_EVENT, label: 'y'.repeat(256) })).isValid).toBe(true);
  });

  it('rejects out-of-range ordinal / total (must be within [1, 50])', async () => {
    expect((await validateDto({ ...VALID_EVENT, ordinal: 0 })).isValid).toBe(false);
    expect((await validateDto({ ...VALID_EVENT, ordinal: 51 })).isValid).toBe(false);
    expect((await validateDto({ ...VALID_EVENT, total: 0 })).isValid).toBe(false);
    expect((await validateDto({ ...VALID_EVENT, total: 51 })).isValid).toBe(false);
  });

  it('accepts boundary ordinals (1 and 50)', async () => {
    expect((await validateDto({ ...VALID_EVENT, ordinal: 1, total: 50 })).isValid).toBe(true);
    expect((await validateDto({ ...VALID_EVENT, ordinal: 50, total: 50 })).isValid).toBe(true);
  });
});
