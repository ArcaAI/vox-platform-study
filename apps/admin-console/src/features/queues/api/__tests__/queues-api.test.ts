import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bulkJobAction,
  cleanQueue,
  getJob,
  getQueue,
  listJobs,
  listQueues,
  listSchedulers,
  pauseQueue,
  pauseScheduler,
  promoteJob,
  removeJob,
  resumeQueue,
  resumeScheduler,
  retryJob,
  toggleScheduler,
  updateSchedulerCron,
} from '../client';
import { queueKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ success: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queueKeys', () => {
  it('is stable and separates queues, jobs and schedulers', () => {
    expect(queueKeys.list()).toEqual(queueKeys.list());
    expect(queueKeys.jobs('text', { page: 0 })).toEqual(queueKeys.jobs('text', { page: 0 }));
    expect(queueKeys.jobs('text')).not.toEqual(queueKeys.jobs('stt'));
    expect(queueKeys.job('text', 'j-1')).not.toEqual(queueKeys.jobs('text'));
    expect(queueKeys.schedulers()[0]).toBe('queues');
  });
});

describe('queues client', () => {
  it('covers queue reads and pause/resume/clean controls', async () => {
    const calls = installFetchMock();
    await listQueues();
    await getQueue('text');
    await pauseQueue('text');
    await resumeQueue('text');
    await cleanQueue('text', { status: 'failed', gracePeriodMs: 0 });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/queues',
      'GET /api/hope/admin/queues/text',
      'POST /api/hope/admin/queues/text/pause',
      'POST /api/hope/admin/queues/text/resume',
      'POST /api/hope/admin/queues/text/clean',
    ]);
    expect(calls[4].body).toEqual({ status: 'failed', gracePeriodMs: 0 });
  });

  it('drives job listing (custom items envelope) and per-job actions', async () => {
    const calls = installFetchMock();
    await listJobs('text', { page: 0, limit: 50, status: 'failed' });
    await getJob('text', 'j-1');
    await retryJob('text', 'j-1');
    await promoteJob('text', 'j-1');
    await removeJob('text', 'j-1');
    await bulkJobAction('text', { action: 'retry', jobIds: ['j-1', 'j-2'] });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/queues/text/jobs?page=0&limit=50&status=failed',
      'GET /api/hope/admin/queues/text/jobs/j-1',
      'POST /api/hope/admin/queues/text/jobs/j-1/retry',
      'POST /api/hope/admin/queues/text/jobs/j-1/promote',
      'DELETE /api/hope/admin/queues/text/jobs/j-1',
      'POST /api/hope/admin/queues/text/jobs/bulk',
    ]);
    expect(calls[5].body).toEqual({ action: 'retry', jobIds: ['j-1', 'j-2'] });
  });

  it('manages schedulers: list, pause/resume, cron, toggle', async () => {
    const calls = installFetchMock();
    await listSchedulers();
    await pauseScheduler('trial-expiry');
    await resumeScheduler('trial-expiry');
    await updateSchedulerCron('trial-expiry', '0 3 * * *');
    await toggleScheduler('trial-expiry', false);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/schedulers',
      'POST /api/hope/admin/schedulers/trial-expiry/pause',
      'POST /api/hope/admin/schedulers/trial-expiry/resume',
      'PATCH /api/hope/admin/schedulers/trial-expiry/cron',
      'PATCH /api/hope/admin/schedulers/trial-expiry/toggle',
    ]);
    expect(calls[3].body).toEqual({ cronExpression: '0 3 * * *' });
    expect(calls[4].body).toEqual({ enabled: false });
  });
});
