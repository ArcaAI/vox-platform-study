/**
 * DNA job-status ownership gate (finding C-01).
 *
 * `getDnaJobStatus` used to hand back `job.returnvalue` — a clinician's private
 * writing-style model — to ANY authenticated caller who guessed a BullMQ job id
 * (ids are sequential integers on a global, un-prefixed queue). These tests lock
 * the ownership assertion: tenant + doctor must match, and a legacy payload
 * carrying neither fails CLOSED.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { getDnaJobStatus, streamDnaJobStatus } from '../dna-writing-style-job-stream';

function queueWith(data: unknown) {
  return {
    getJob: vi.fn(async () => ({
      id: '1',
      data,
      progress: 100,
      returnvalue: { reportId: 'r-1', styleText: 'secret' },
      failedReason: undefined,
      getState: async () => 'completed',
    })),
  } as never;
}

const OWNED = { tenantId: 't-1', doctorId: 'd-1', userId: 'd-1' };

describe('getDnaJobStatus ownership gate', () => {
  it('returns the result when tenant and doctor both match', async () => {
    const res = await getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-1', doctorId: 'd-1' });
    expect(res.status).toBe('completed');
    expect(res.result).toEqual({ reportId: 'r-1', styleText: 'secret' });
  });

  it('404s on a tenant mismatch', async () => {
    await expect(getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-2', doctorId: 'd-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s on a doctor mismatch inside the same tenant', async () => {
    await expect(getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-1', doctorId: 'd-2' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s (fail closed) for a legacy payload with no owner fields', async () => {
    await expect(getDnaJobStatus(queueWith({ jobId: '1' }), '1', { tenantId: 't-1', doctorId: 'd-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s (fail closed) when the caller has no active tenant', async () => {
    await expect(getDnaJobStatus(queueWith(OWNED), '1', { tenantId: null, doctorId: 'd-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('admin access (no doctorId) still requires a tenant match', async () => {
    await expect(getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-2' })).rejects.toBeInstanceOf(NotFoundException);
    const res = await getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-1' });
    expect(res.status).toBe('completed');
  });

  it('accepts the enqueuing user when they are not the subject doctor (impersonation)', async () => {
    const res = await getDnaJobStatus(queueWith({ tenantId: 't-1', doctorId: 'd-1', userId: 'u-9' }), '1', { tenantId: 't-1', doctorId: 'u-9' });
    expect(res.status).toBe('completed');
  });

  it('hides existence — the 404 message never distinguishes missing from foreign', async () => {
    const missing = { getJob: vi.fn(async () => null) } as never;
    const a = await getDnaJobStatus(missing, '1', { tenantId: 't-1', doctorId: 'd-1' }).catch((e) => e.message);
    const b = await getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-2', doctorId: 'd-1' }).catch((e) => e.message);
    expect(a).toBe(b);
  });
});

describe('streamDnaJobStatus ownership gate', () => {
  it('errors the stream on a tenant mismatch instead of emitting the result', async () => {
    await expect(firstValueFrom(streamDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-2', doctorId: 'd-1' }))).rejects.toBeInstanceOf(NotFoundException);
  });
});
