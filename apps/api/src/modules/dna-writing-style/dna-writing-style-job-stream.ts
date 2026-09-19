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
  /**
   * TASK-974 §4.1 — the CREDENTIAL, when the caller is a machine (API key / service account).
   *
   * Present (even as `null`) DECLARES the caller a machine and selects the machine gate, which
   * is why it is checked before the admin branch: a machine caller has no `doctorId`, and
   * falling through to `doctorId === undefined` would hand it the tenant-wide admin reach.
   *
   * The comparison is against `requestedBy.principalId` on the job, not against the bound user:
   * a machine acts "as" a user, so two service accounts in one tenant both resolve to clinicians
   * of that tenant and the doctor rule could not tell their jobs apart.
   */
  machinePrincipalId?: string | null;
}

/** Owner fields stamped onto the job payload at enqueue time (`GenerateDnaReportJobPayload`). */
interface DnaJobOwnerFields {
  tenantId?: unknown;
  doctorId?: unknown;
  userId?: unknown;
  requestedBy?: { credentialClass?: unknown; principalId?: unknown };
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

  // TASK-974 — MACHINE surface. FAIL CLOSED in both directions: a machine with no principal
  // reads nothing, and a job with no `requestedBy` (a human's, or one enqueued by an older
  // build) is not a machine's to read. Deliberately BEFORE the admin branch — see
  // `DnaJobAccess.machinePrincipalId`.
  if (access.machinePrincipalId !== undefined) {
    const jobPrincipalId = typeof payload?.requestedBy?.principalId === 'string' ? payload.requestedBy.principalId : null;
    if (!access.machinePrincipalId || jobPrincipalId !== access.machinePrincipalId) {
      throw notFound();
    }
    return;
  }

  // Admin surface: tenant match is the whole gate (ability is tenant-scoped).
  if (access.doctorId === undefined) {
    return;
  }

  // Doctor surface: the caller must be the subject doctor OR the principal who
  // enqueued it (an admin impersonating a doctor has both stamped).
  //
  // L5/F1 — the enqueuing-user disjunct is for HUMAN impersonation ONLY. On a job a MACHINE
  // enqueued, the credential's bound human never asked for anything, so accepting them here would
  // hand them another clinician's writing-style model through this route. `DnaWritingStyleService`
  // also stamps the CLINICIAN as a machine job's `userId`, which closes the same hole from the
  // other end; this keeps it closed if that payload ever changes again.
  const enqueuedByMachine = payload?.requestedBy?.credentialClass === 'api-key' || payload?.requestedBy?.credentialClass === 'service-account';
  const ownerIds = enqueuedByMachine ? [jobDoctorId] : [jobDoctorId, jobUserId];
  if (!access.doctorId || !ownerIds.includes(access.doctorId)) {
    throw notFound();
  }
}

/**
 * TASK-991 defect 2 — `job.failedReason` is BullMQ's own `Error.message` from whatever the
 * `DnaWritingStyleProcessor` last threw. Most of its guarded early-exits raise a fixed, static,
 * user-meaningful string; its OUTER catch-all
 * (`packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:538`,
 * `throw error`) rethrows the ORIGINAL error unchanged whenever something else escaped —
 * including a raw Prisma/axios error whose `.message` can carry a container path, the tenant id,
 * the doctor id and the full column list of the failing query. `redactTopology` alone does not
 * catch this (it strips file paths only, leaving ids and column names intact), so this is
 * ALLOW-LIST based and FAILS CLOSED: only a known-safe reason passes through unchanged, anything
 * else — including an internal error we didn't anticipate — collapses to the generic message.
 *
 * Keep this set in sync BY HAND with the static `throw new Error(...)` sites in that processor
 * (verified against it 2026-09-19):
 *   - :238        'DNA writing style is disabled for this doctor (opt-out or tenant flag off)'
 *   - :266        'No text samples available for DNA analysis'
 *   - :301        'No approved text samples available for DNA analysis'
 *   - :320        'PHI redactor is not available; refusing to send an unredacted DNA corpus to TEXT'
 *   - :384-387    'No DNA analysis instruction could be resolved: this tenant has authored no
 *                  DNA_ANALYSIS prompt template and the platform analyst agent carries no
 *                  compiled prompt.'
 *   - :401/:404   'DNA analysis output schema could not be resolved; refusing to generate an
 *                  unconstrained writing-style profile'
 *   - :422/434/454 'DNA analysis returned an unparseable or non-conforming response'
 *
 * Deliberately NOT allow-listed: `DNA_ANALYST_AGENT_UNAVAILABLE` (:896-899) and
 * `DNA_INGEST_WRITTEN_AT_INVALID` (:950-953) — both INTERPOLATE a value (an agent slug; an
 * ingested item's index and raw `writtenAt` string) rather than being a fixed string, so an
 * exact-match allow-list can't safely admit them; they fall through to the generic message.
 */
const KNOWN_DNA_JOB_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'DNA writing style is disabled for this doctor (opt-out or tenant flag off)',
  'No text samples available for DNA analysis',
  'No approved text samples available for DNA analysis',
  'PHI redactor is not available; refusing to send an unredacted DNA corpus to TEXT',
  'No DNA analysis instruction could be resolved: this tenant has authored no DNA_ANALYSIS prompt template and the platform analyst agent carries no compiled prompt.',
  'DNA analysis output schema could not be resolved; refusing to generate an unconstrained writing-style profile',
  'DNA analysis returned an unparseable or non-conforming response',
]);

const GENERIC_DNA_JOB_FAILURE_MESSAGE = 'Generation failed';

/** Allow-list gate for a DNA job's `error` field — see the block comment above. Fails closed. */
export function safeJobError(failedReason: string | undefined): string {
  if (failedReason && KNOWN_DNA_JOB_FAILURE_REASONS.has(failedReason)) {
    return failedReason;
  }
  return GENERIC_DNA_JOB_FAILURE_MESSAGE;
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
    // ALLOW-LIST, not `redactTopology` — see `safeJobError` above. This is the POLL route's
    // return value, so it must be safe on its own; the SSE emission below applies the same gate
    // independently rather than trusting that this one ran.
    error: status === 'failed' ? safeJobError(job.failedReason) : undefined,
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
            // `status.error` already went through `safeJobError` inside
            // `getDnaJobStatus` above, so it is allow-list-safe by the time it
            // reaches here. `redactTopology` stays in the chain as a first
            // pass (defense in depth — the processor calls apps/text, so an
            // unwrapped axios rejection can carry host:port), but
            // `safeJobError` is what actually DECIDES the final string, so
            // this emission can never disagree with the poll route about
            // what is safe to ship to the browser. The processor's own log
            // keeps the full reason.
            data: JSON.stringify({ jobId: status.jobId, error: safeJobError(redactTopology(status.error ?? 'Generation failed')) }),
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
