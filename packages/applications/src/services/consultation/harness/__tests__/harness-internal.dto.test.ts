/**
 * HarnessProgressRequest DTO Validation Tests.
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
  HARNESS_ESCALATION_REASONS,
  HARNESS_PROGRESS_FAILED_STAGE,
  HARNESS_PROGRESS_STAGE_KEYS,
  HARNESS_PROGRESS_TERMINAL_STAGE,
  HarnessEntityItem,
  HarnessEscalationRequest,
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

// ---------------------------------------------------------------------------
// HarnessEscalationRequest (gate SLA-breach escalation).
//
// The harness `escalate_gate` activity POSTs {tenantId, reason, jobId?}; the
// global pipe is whitelist + forbidNonWhitelisted, so `reason` is pinned to the
// two harness reason strings and tenantId is required.
// ---------------------------------------------------------------------------

async function validateEscalation(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(HarnessEscalationRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('HarnessEscalationRequest (C1-05)', () => {
  it('accepts a well-formed escalation with all fields ({tenantId, reason, jobId})', async () => {
    expect((await validateEscalation({ tenantId: 'tenant-1', reason: 'gate_sla_breached', jobId: 'harness-doc-1' })).isValid).toBe(true);
  });

  it('accepts both harness reason values with jobId omitted (optional)', async () => {
    for (const reason of HARNESS_ESCALATION_REASONS) {
      const result = await validateEscalation({ tenantId: 'tenant-1', reason });
      expect(result.isValid, `reason ${reason} should validate`).toBe(true);
    }
  });

  it('rejects a missing tenantId', async () => {
    expect((await validateEscalation({ reason: 'gate_sla_breached' })).isValid).toBe(false);
  });

  it('rejects a missing reason', async () => {
    expect((await validateEscalation({ tenantId: 'tenant-1' })).isValid).toBe(false);
  });

  it('rejects an unknown reason (pinned to the two harness reasons)', async () => {
    expect((await validateEscalation({ tenantId: 'tenant-1', reason: 'something_else' })).isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HarnessEntityItem carries the five ontology codes. They are
// declared class-validator fields (@IsOptional @IsString), so a coded entity
// validates and a non-string code is rejected.
// ---------------------------------------------------------------------------

async function validateEntityItem(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(HarnessEntityItem, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('HarnessEntityItem ontology codes (TASK-476 C1)', () => {
  it('accepts a coded entity with all five ontology codes', async () => {
    const result = await validateEntityItem({
      text: 'metformin',
      type: 'MEDICATION',
      umlsCui: 'C0025598',
      snomedCode: '372567009',
      rxnormCode: '6809',
      icdCode: 'E11.9',
      loincCode: '4548-4',
    });
    expect(result.isValid).toBe(true);
  });

  it('accepts an un-coded entity (all codes optional)', async () => {
    expect((await validateEntityItem({ text: 'headache', type: 'SYMPTOM' })).isValid).toBe(true);
  });

  it('rejects a non-string ontology code', async () => {
    expect((await validateEntityItem({ text: 'metformin', type: 'MEDICATION', rxnormCode: 6809 })).isValid).toBe(false);
  });
});
