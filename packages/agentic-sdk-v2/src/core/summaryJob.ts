/**
 * @arcaai/vox - Summary generation over the async job plane (TASK-1012 L-2)
 *
 * The gateway generates a note ONLY through the async plane
 * (`POST …/summary/async`, `POST …/summary/pre-summary/async`); the synchronous
 * `POST …/summary` and `POST …/summary/pre-summary` were removed by TASK-1006
 * (OD-2) and answer 404. The promise-of-a-note hooks (`generateSummary`,
 * `generatePreSummary`, `KnowledgePipeline.triggerSummarization`) keep their
 * signatures by starting the async job, polling `GET /consultations/jobs/:jobId`
 * (the same record `useConsultationJob` reads) to completion, and then reading
 * the persisted note from `…/summary/latest` / `…/summary/pre-summary/latest`.
 *
 * Internal module — not exported from the package barrels.
 */

import { CONSULTATION_JOB_ENDPOINTS, SUMMARY_ENDPOINTS } from './constants';
import type { ConsultationJob } from '../types/consultation-job';
import type { AsyncJobResponse, SummaryGenerationOptions, SummaryResponse } from '../types/summary';

/** Which note the job produces. */
export type SummaryJobKind = 'summary' | 'pre-summary';

/** The two `AgenticClient` methods this module needs (duck-typed so tests can pass a mock). */
export interface SummaryJobApiClient {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, body?: unknown): Promise<T>;
}

export interface AwaitSummaryJobOptions {
  /** Delay between job reads. Default {@link SUMMARY_JOB_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Give up after this long. Default {@link SUMMARY_JOB_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Test seam — defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/** Same cadence as `useConsultationJob.pollJob`. */
export const SUMMARY_JOB_POLL_INTERVAL_MS = 2000;
/** A harness note run includes the safety sensors; five minutes bounds a run that never reports. */
export const SUMMARY_JOB_TIMEOUT_MS = 5 * 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reconcile the deprecated SDK option names to the gateway DTO fields
 * (`GenerateSummaryRequest`), which rejects unknown keys (`forbidNonWhitelisted`):
 * `transcript` → `transcription`, `promptTemplateId` → `template`,
 * `departmentId` → `options.departmentId`.
 */
export function mapSummaryOptionsToBackend(options?: SummaryGenerationOptions): Record<string, unknown> | undefined {
  if (!options) return undefined;

  const { transcript, promptTemplateId, departmentId, transcription, template, options: optsBag, ...rest } = options;

  const out: Record<string, unknown> = { ...rest };
  const canonicalTranscription = transcription ?? transcript;
  const canonicalTemplate = template ?? promptTemplateId;

  if (canonicalTranscription !== undefined) out.transcription = canonicalTranscription;
  if (canonicalTemplate !== undefined) out.template = canonicalTemplate;

  if (departmentId !== undefined || optsBag !== undefined) {
    out.options = {
      ...(optsBag ?? {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
    };
  }

  return out;
}

/**
 * Poll an async note job until the note is persisted, then return it.
 *
 * Done = a `COMPLETED` status, OR `progress >= 100`: the harness note job
 * (`…/summary/async`) is published `RUNNING` / 100 ("Draft ready for review",
 * "Assurance complete") once the draft is persisted and is never moved to a
 * terminal status by the gateway, so waiting for one would never end.
 * `FAILED` / `CANCELLED` reject with the job's error; so does the timeout.
 */
export async function awaitSummaryJob(
  apiClient: SummaryJobApiClient,
  consultationId: string,
  jobId: string,
  kind: SummaryJobKind,
  options: AwaitSummaryJobOptions = {},
): Promise<SummaryResponse> {
  const pollIntervalMs = options.pollIntervalMs ?? SUMMARY_JOB_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SUMMARY_JOB_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    const job = await apiClient.get<ConsultationJob>(CONSULTATION_JOB_ENDPOINTS.GET(jobId));
    const status = String(job?.status ?? '').toLowerCase();

    if (status === 'failed' || status === 'cancelled') {
      throw new Error(job.error || `The ${kind} job ${jobId} ${status}`);
    }
    if (status === 'completed' || (typeof job?.progress === 'number' && job.progress >= 100)) {
      break;
    }
    if (now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the ${kind} job ${jobId}`);
    }
    await sleep(pollIntervalMs);
  }

  const latest = kind === 'summary' ? SUMMARY_ENDPOINTS.LATEST(consultationId) : SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(consultationId);
  return apiClient.get<SummaryResponse>(latest);
}

/**
 * Start a note on the async plane and resolve it once persisted — the
 * replacement for the removed synchronous `POST …/summary[/pre-summary]`.
 */
export async function generateSummaryViaJob(
  apiClient: SummaryJobApiClient,
  consultationId: string,
  kind: SummaryJobKind,
  body: Record<string, unknown> | undefined,
  options: AwaitSummaryJobOptions = {},
): Promise<SummaryResponse> {
  const url = kind === 'summary' ? SUMMARY_ENDPOINTS.GENERATE_ASYNC(consultationId) : SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(consultationId);
  const job = await apiClient.post<AsyncJobResponse>(url, body ?? {});
  return awaitSummaryJob(apiClient, consultationId, job.jobId, kind, options);
}
