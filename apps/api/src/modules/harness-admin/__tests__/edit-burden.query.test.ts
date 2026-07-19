/**
 * `EditBurdenQuery` validation (TASK-508 Phase 0 D3) — driven through the REAL
 * global ValidationPipe config (main.ts: transform + whitelist +
 * forbidNonWhitelisted + forbidUnknownValues), same style as
 * `ai-inference.dto.test.ts`. `GET admin/harness/edit-burden` delegates to
 * `HarnessObservabilityService#getEditBurden(tenantId, consultationId)` — the
 * real signature takes a single `consultationId`, not a `from`/`to` date
 * range, so `consultationId` is the only required field here.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { EditBurdenQuery } from '../dto/edit-burden.query';

const PIPE_CFG = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

async function runPipe(value: unknown): Promise<unknown> {
  const pipe = new ValidationPipe(PIPE_CFG);
  return pipe.transform(value, { type: 'query', metatype: EditBurdenQuery } as never);
}

async function expectRejected(value: unknown): Promise<void> {
  await expect(runPipe(value)).rejects.toBeInstanceOf(BadRequestException);
}

describe('EditBurdenQuery validation', () => {
  it('accepts a bare consultationId', async () => {
    await expect(runPipe({ consultationId: 'c1' })).resolves.toMatchObject({ consultationId: 'c1' });
  });

  it('accepts consultationId + the platform-admin tenantId override', async () => {
    await expect(runPipe({ consultationId: 'c1', tenantId: 't1' })).resolves.toMatchObject({ consultationId: 'c1', tenantId: 't1' });
  });

  it('rejects a missing consultationId', async () => {
    await expectRejected({});
  });

  it('rejects an empty-string consultationId', async () => {
    await expectRejected({ consultationId: '' });
  });

  it('rejects an undeclared/smuggled query field (forbidNonWhitelisted)', async () => {
    await expectRejected({ consultationId: 'c1', from: '2026-01-01T00:00:00.000Z' });
  });
});
