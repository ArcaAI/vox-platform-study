/**
 * TASK-1012 (L-2) — the synchronous summary routes are gone.
 *
 * `POST /consultations/:id/summary` and `POST …/summary/pre-summary` were removed by
 * TASK-1006 (OD-2): a note is generated only through the async plane. SDK 4.0.0 still
 * POSTed to them, so `generateSummary` / `generatePreSummary` 404'd. This helper starts
 * the async job, polls `GET /consultations/jobs/:jobId` to completion, then reads the
 * persisted note from `…/summary/latest` (or `…/pre-summary/latest`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitSummaryJob, generateSummaryViaJob, mapSummaryOptionsToBackend, type SummaryJobApiClient } from '../summaryJob';
import { CONSULTATION_JOB_ENDPOINTS, SUMMARY_ENDPOINTS } from '../constants';

const CID = 'c-001';
const summary = { id: 's-1', contextItemId: 's-1', content: 'Summary', type: 'summary', createdAt: '' };
const preSummary = { id: 'ps-1', contextItemId: 'ps-1', content: 'Pre', type: 'pre_summary', createdAt: '' };

function makeClient(jobs: Array<Record<string, unknown>>) {
  const queue = [...jobs];
  const get = vi.fn(async (url: string) => {
    if (url === CONSULTATION_JOB_ENDPOINTS.GET('job-1')) return queue.length > 1 ? queue.shift() : queue[0];
    if (url === SUMMARY_ENDPOINTS.LATEST(CID)) return summary;
    if (url === SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(CID)) return preSummary;
    throw new Error(`unexpected GET ${url}`);
  });
  const post = vi.fn(async () => ({ jobId: 'job-1', status: 'pending', consultationId: CID, createdAt: '' }));
  // The spies are concretely typed; the helper takes the generic duck-typed pair.
  return { get, post, client: { get, post } as unknown as SummaryJobApiClient };
}

const noSleep = () => Promise.resolve();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateSummaryViaJob (TASK-1012 L-2)', () => {
  it('summary: POSTs the ASYNC route — never the removed synchronous one — and resolves the persisted note', async () => {
    const client = makeClient([{ jobId: 'job-1', status: 'COMPLETED', progress: 100 }]);

    const result = await generateSummaryViaJob(client.client, CID, 'summary', { dnaStyleId: 'dna-1' }, { sleep: noSleep });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC(CID), { dnaStyleId: 'dna-1' });
    expect(client.post).not.toHaveBeenCalledWith(`/consultations/${CID}/summary`, expect.anything());
    expect(client.get).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.GET('job-1'));
    expect(client.get).toHaveBeenLastCalledWith(SUMMARY_ENDPOINTS.LATEST(CID));
    expect(result).toEqual(summary);
  });

  it('pre-summary: POSTs …/pre-summary/async and resolves the latest pre-summary', async () => {
    const client = makeClient([{ jobId: 'job-1', status: 'COMPLETED', progress: 100 }]);

    const result = await generateSummaryViaJob(client.client, CID, 'pre-summary', undefined, { sleep: noSleep });

    expect(client.post).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(CID), {});
    expect(client.get).toHaveBeenLastCalledWith(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(CID));
    expect(result).toEqual(preSummary);
  });
});

describe('awaitSummaryJob (TASK-1012 L-2)', () => {
  it('polls until the job completes, sleeping the poll interval between reads', async () => {
    const client = makeClient([
      { jobId: 'job-1', status: 'PENDING', progress: 0 },
      { jobId: 'job-1', status: 'RUNNING', progress: 40 },
      { jobId: 'job-1', status: 'COMPLETED', progress: 100 },
    ]);
    const sleep = vi.fn(noSleep);

    const result = await awaitSummaryJob(client.client, CID, 'job-1', 'pre-summary', { sleep, pollIntervalMs: 50 });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(result).toEqual(preSummary);
  });

  it('treats the harness "draft ready" signal (progress 100, no terminal status) as done', async () => {
    // The harness note job is published RUNNING/100 when the draft is persisted and is never
    // moved to COMPLETED by the gateway — waiting for a terminal status would hang forever.
    const client = makeClient([{ jobId: 'job-1', status: 'RUNNING', progress: 100, currentStep: 'Draft ready for review' }]);

    const result = await awaitSummaryJob(client.client, CID, 'job-1', 'summary', { sleep: noSleep });

    expect(result).toEqual(summary);
  });

  it('rejects with the job error when the job FAILED, and never reads a stale "latest" note', async () => {
    const client = makeClient([{ jobId: 'job-1', status: 'FAILED', progress: 20, error: 'LLM unavailable' }]);

    await expect(awaitSummaryJob(client.client, CID, 'job-1', 'pre-summary', { sleep: noSleep })).rejects.toThrow('LLM unavailable');
    expect(client.get).not.toHaveBeenCalledWith(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(CID));
  });

  it('rejects when the job is CANCELLED', async () => {
    const client = makeClient([{ jobId: 'job-1', status: 'CANCELLED', progress: 0 }]);

    await expect(awaitSummaryJob(client.client, CID, 'job-1', 'summary', { sleep: noSleep })).rejects.toThrow(/cancelled/i);
  });

  it('rejects once the timeout elapses without completion', async () => {
    const client = makeClient([{ jobId: 'job-1', status: 'RUNNING', progress: 10 }]);
    let t = 0;
    const now = () => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });

    await expect(awaitSummaryJob(client.client, CID, 'job-1', 'summary', { sleep, now, pollIntervalMs: 1000, timeoutMs: 3000 })).rejects.toThrow(
      /timed out/i,
    );
    expect(client.get).not.toHaveBeenCalledWith(SUMMARY_ENDPOINTS.LATEST(CID));
  });
});

/**
 * The body of each async route is bound to a DIFFERENT gateway DTO and the global ValidationPipe is
 * `forbidNonWhitelisted`, so a key outside the DTO is a 400. Fields copied from:
 *   summary     — packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts:8,13,18,23,29,34,44
 *   pre-summary — packages/applications/src/services/consultation/summary/dto/generate-presummary.request.ts:8,14,19,25
 */
const SUMMARY_DTO_FIELDS = ['transcription', 'dnaStyleId', 'template', 'includeNER', 'contextItemIds', 'options', 'idempotencyKey'];
const PRE_SUMMARY_DTO_FIELDS = ['dnaStyleId', 'caseNoteIds', 'options', 'idempotencyKey'];

const kitchenSink = {
  transcript: 'tx',
  promptTemplateId: 'pt',
  includeNER: true,
  departmentId: 'dept-1',
  dnaStyleId: 'dna-1',
  type: 'summary',
} as unknown as Parameters<typeof mapSummaryOptionsToBackend>[1];

describe('mapSummaryOptionsToBackend — per-kind DTO whitelist (TASK-1012)', () => {
  it('pre-summary: every key is a GeneratePreSummaryRequest field; legacy/summary-only keys are dropped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = mapSummaryOptionsToBackend('pre-summary', kitchenSink)!;

    for (const key of Object.keys(body)) expect(PRE_SUMMARY_DTO_FIELDS).toContain(key);
    expect(body).toEqual({ dnaStyleId: 'dna-1' });
  });

  it('summary: every key is a GenerateSummaryRequest field; deprecated names map onto it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = mapSummaryOptionsToBackend('summary', kitchenSink)!;

    for (const key of Object.keys(body)) expect(SUMMARY_DTO_FIELDS).toContain(key);
    // `departmentId` is dropped, not tucked into `options`: the gateway reads the department
    // from the consultation row and never reads `options.departmentId` on either route.
    expect(body).toEqual({ transcription: 'tx', template: 'pt', includeNER: true, dnaStyleId: 'dna-1' });
  });

  it('keeps the caller options bag and pre-summary caseNoteIds verbatim', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { options: { tone: 'concise' }, caseNoteIds: ['cn-1'], idempotencyKey: 'k-1' } as unknown as Parameters<
      typeof mapSummaryOptionsToBackend
    >[1];

    expect(mapSummaryOptionsToBackend('pre-summary', opts)).toEqual({ options: { tone: 'concise' }, caseNoteIds: ['cn-1'], idempotencyKey: 'k-1' });
    expect(mapSummaryOptionsToBackend('summary', opts)).toEqual({ options: { tone: 'concise' }, idempotencyKey: 'k-1' });
  });

  it('returns undefined for no options', () => {
    expect(mapSummaryOptionsToBackend('summary', undefined)).toBeUndefined();
  });

  it('warns once per dropped key (per kind), naming it', async () => {
    vi.resetModules();
    const fresh = await import('../summaryJob.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fresh.mapSummaryOptionsToBackend('pre-summary', kitchenSink);
    fresh.mapSummaryOptionsToBackend('pre-summary', kitchenSink);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    for (const key of ['transcript', 'promptTemplateId', 'includeNER', 'departmentId', 'type']) expect(message).toContain(key);
    warn.mockRestore();
  });
});
