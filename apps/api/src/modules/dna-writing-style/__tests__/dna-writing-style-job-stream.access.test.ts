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

/** TASK-974 — a job a MACHINE enqueued, stamped with the credential that did it. */
const MACHINE_OWNED = { tenantId: 't-1', doctorId: 'd-1', userId: 'd-1', requestedBy: { credentialClass: 'service-account', principalId: 'svc-1' } };

/**
 * TASK-974 §4.1 — the MACHINE reader's gate.
 *
 * A machine acts "as" a bound user, so the user id cannot tell one credential's job from
 * another's: two service accounts in a tenant both resolve to clinicians of that tenant, and the
 * doctor rule would let either read the other's results. The gate is therefore the CREDENTIAL
 * that enqueued the job, compared by id — the only fact that distinguishes them.
 */
describe('getDnaJobStatus — a machine reads back only what IT enqueued', () => {
  it('serves the job to the credential that enqueued it', async () => {
    const res = await getDnaJobStatus(queueWith(MACHINE_OWNED), '1', { tenantId: 't-1', machinePrincipalId: 'svc-1' });
    expect(res.status).toBe('completed');
  });

  it('404s for a DIFFERENT credential of the same tenant', async () => {
    await expect(getDnaJobStatus(queueWith(MACHINE_OWNED), '1', { tenantId: 't-1', machinePrincipalId: 'svc-2' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s (fail closed) for a job with no `requestedBy` — a human`s job is not a machine`s to read', async () => {
    await expect(getDnaJobStatus(queueWith(OWNED), '1', { tenantId: 't-1', machinePrincipalId: 'svc-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does NOT fall through to the tenant-only admin branch when the principal is absent', async () => {
    // `machinePrincipalId` present-but-empty must never read as "no machine gate declared".
    await expect(getDnaJobStatus(queueWith(MACHINE_OWNED), '1', { tenantId: 't-1', machinePrincipalId: null })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('still requires the tenant to match', async () => {
    await expect(getDnaJobStatus(queueWith(MACHINE_OWNED), '1', { tenantId: 't-2', machinePrincipalId: 'svc-1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

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

/**
 * L5/F1 — a MACHINE-enqueued job is not readable through the HUMAN disjunct.
 *
 * The doctor branch accepts the job's `userId` as well as its `doctorId`, so that an admin who
 * IMPERSONATED a clinician can poll the job they started. A machine's bound human is not an
 * impersonator: they never asked for anything, and on a job a credential enqueued for somebody
 * else that disjunct would hand them another clinician's writing-style model — through
 * `GET dna-writing-styles/jobs/:jobId`, a route this ticket never touched.
 *
 * Two locks, deliberately: `DnaWritingStyleService` stamps the CLINICIAN as a machine job's
 * `userId`, and the gate below ignores that field entirely once `requestedBy` says a machine
 * enqueued it. Either alone would close today's hole; together they survive the next payload
 * change.
 */
describe('a machine-enqueued job is read by its SUBJECT, never by the credential`s bound human', () => {
  const machineJobFor = (doctorId: string, userId: string) => ({
    tenantId: 't-1',
    doctorId,
    userId,
    requestedBy: { credentialClass: 'api-key', principalId: 'key-1' },
  });

  it('404s for a non-admin human the job was merely enqueued BY', async () => {
    await expect(getDnaJobStatus(queueWith(machineJobFor('d-1', 'u-9')), '1', { tenantId: 't-1', doctorId: 'u-9' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('serves it to the clinician it is ABOUT', async () => {
    const res = await getDnaJobStatus(queueWith(machineJobFor('d-1', 'd-1')), '1', { tenantId: 't-1', doctorId: 'd-1' });
    expect(res.status).toBe('completed');
  });

  it('leaves HUMAN impersonation alone — a job with no `requestedBy` keeps the enqueuing-user disjunct', async () => {
    const res = await getDnaJobStatus(queueWith({ tenantId: 't-1', doctorId: 'd-1', userId: 'u-9' }), '1', { tenantId: 't-1', doctorId: 'u-9' });
    expect(res.status).toBe('completed');
  });

  it('leaves the tenant-wide ADMIN branch alone', async () => {
    const res = await getDnaJobStatus(queueWith(machineJobFor('d-1', 'd-1')), '1', { tenantId: 't-1' });
    expect(res.status).toBe('completed');
  });
});
