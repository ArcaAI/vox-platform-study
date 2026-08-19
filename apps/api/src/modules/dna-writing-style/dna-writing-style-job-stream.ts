import { NotFoundException, type MessageEvent } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { redactTopology } from '../../filters/downstream-error';
import type { DnaJobStatusResponseDto } from './dna-writing-style.dto';

type BullMQJobState = 'completed' | 'failed' | 'active' | 'delayed' | 'waiting' | 'waiting-children' | 'prioritized' | 'unknown';

export function mapBullStateToDnaStatus(state: BullMQJobState): 'queued' | 'processing' | 'completed' | 'failed' {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'processing';
    default:
      return 'queued';
  }
}

function toProgress(progress: Job['progress'], status: DnaJobStatusResponseDto['status']): number {
  if (typeof progress === 'number') return progress;
  if (status === 'completed') return 100;
  if (status === 'processing') return 40;
  return 10;
}

/**
 * Who is asking. `tenantId` is the caller's ACTIVE (CLS) tenant; `doctorId` is
 * the caller's own user id and is omitted ONLY by the admin surface, whose
 * `manage:DnaWritingStyleReport` ability is tenant-wide but never cross-tenant.
 */
export interface DnaJobAccess {
  tenantId: string | null;
  doctorId?: string | null;
}

/** Owner fields stamped onto the job payload at enqueue time (`GenerateDnaReportJobPayload`). */
interface DnaJobOwnerFields {
  tenantId?: unknown;
  doctorId?: unknown;
  userId?: unknown;
}

/**
 * Finding C-01 — the BullMQ queue `JobQueue.GenerateDnaReport` is GLOBAL (no
 * per-tenant prefix) and BullMQ job ids are enumerable, while `job.returnvalue`
 * is `{ reportId, reportData, styleText }` — a clinician's private writing-style
 * model. Neither job route went through the service, so neither inherited its
 * tenant/owner guards. This is that guard.
 *
 * FAIL CLOSED: a payload that carries no `tenantId`/`doctorId` (a job enqueued
 * by an older build and still in flight) is treated as NOT the caller's. A
 * missing field must never read as "allow" — that is the same defect wearing a
 * different hat. Such jobs simply report 404 until they drain; the client
 * re-generates.
 *
 * Every rejection is the SAME `NotFoundException` the missing-job branch throws
 * (404-over-403), so a foreign job is indistinguishable from a nonexistent one.
 */
function assertDnaJobAccess(payload: DnaJobOwnerFields | undefined | null, jobId: string, access: DnaJobAccess): void {
  const notFound = () => new NotFoundException(`Job ${jobId} not found`);

  const jobTenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
  const jobDoctorId = typeof payload?.doctorId === 'string' ? payload.doctorId : null;
  const jobUserId = typeof payload?.userId === 'string' ? payload.userId : null;

  // Legacy / malformed payload — no owner to compare against.
  if (!jobTenantId || !jobDoctorId) {
    throw notFound();
  }

  // No active tenant can own any job.
  if (!access.tenantId || jobTenantId !== access.tenantId) {
    throw notFound();
  }

  // Admin surface: tenant match is the whole gate (ability is tenant-scoped).
  if (access.doctorId === undefined) {
    return;
  }

  // Doctor surface: the caller must be the subject doctor OR the principal who
  // enqueued it (an admin impersonating a doctor has both stamped).
  if (!access.doctorId || (jobDoctorId !== access.doctorId && jobUserId !== access.doctorId)) {
    throw notFound();
  }
}

export async function getDnaJobStatus(dnaQueue: Queue, jobId: string, access: DnaJobAccess): Promise<DnaJobStatusResponseDto> {
  const job = await dnaQueue.getJob(jobId);
  if (!job) {
    throw new NotFoundException(`Job ${jobId} not found`);
  }

  assertDnaJobAccess(job.data as DnaJobOwnerFields | undefined, jobId, access);

  const state = (await job.getState()) as BullMQJobState;
  const status = mapBullStateToDnaStatus(state);

  return {
    jobId: job.id!,
    status,
    progress: toProgress(job.progress, status),
    result: status === 'completed' ? job.returnvalue : undefined,
    error: status === 'failed' ? job.failedReason : undefined,
  };
}

export function streamDnaJobStatus(dnaQueue: Queue, jobId: string, access: DnaJobAccess): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastPayload = '';

    const emit = async () => {
      try {
        const status = await getDnaJobStatus(dnaQueue, jobId, access);
        const payload = JSON.stringify(status);

        if (payload !== lastPayload) {
          subscriber.next({ type: 'status', data: payload } as MessageEvent);
          subscriber.next({ type: 'progress', data: JSON.stringify({ jobId: status.jobId, progress: status.progress }) } as MessageEvent);
          lastPayload = payload;
        }

        if (status.status === 'completed') {
          subscriber.next({ type: 'result', data: JSON.stringify(status.result ?? null) } as MessageEvent);
          subscriber.complete();
        }

        if (status.status === 'failed') {
          subscriber.next({
            type: 'error',
            // TASK-768: `status.error` is the BullMQ `failedReason`. The DNA
            // processor calls apps/text, so an unwrapped axios rejection lands
            // here verbatim — host:port included — and is relayed to the
            // browser. Redacted on the way out; the processor's own log keeps
            // the full reason.
            data: JSON.stringify({ jobId: status.jobId, error: redactTopology(status.error ?? 'Generation failed') }),
          } as MessageEvent);
          subscriber.complete();
        }
      } catch (error) {
        subscriber.error(error);
      }
    };

    void emit();
    timer = setInterval(() => void emit(), 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  });
}
