/**
 * TASK-1012 (L-2) — the synchronous summary routes are gone.
 *
 * `POST /consultations/:id/summary` and `POST …/summary/pre-summary` were removed by
 * TASK-1006 (OD-2): a note is generated only through the async plane. SDK 4.0.0 still
 * POSTed to them, so `generateSummary` / `generatePreSummary` 404'd. This helper starts
 * the async job, polls `GET /consultations/jobs/:jobId` to completion, then reads the
 * persisted note from `…/summary/latest` (or `…/pre-summary/latest`).
 */

import { describe, it, expect, vi } from 'vitest';
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

describe('mapSummaryOptionsToBackend', () => {
  it('maps the deprecated option names onto the gateway DTO fields', () => {
    expect(mapSummaryOptionsToBackend({ transcript: 't', promptTemplateId: 'pt', departmentId: 'd', dnaStyleId: 'x' })).toEqual({
      transcription: 't',
      template: 'pt',
      options: { departmentId: 'd' },
      dnaStyleId: 'x',
    });
  });

  it('returns undefined for no options', () => {
    expect(mapSummaryOptionsToBackend(undefined)).toBeUndefined();
  });
});
