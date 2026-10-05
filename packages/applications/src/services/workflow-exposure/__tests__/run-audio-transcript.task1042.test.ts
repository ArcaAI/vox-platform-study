/**
 * TASK-1042 (C5) — the internal transcript read the harness polls for a run's bound live session:
 * `{ state, language, transcript, finals }`, finals read from `stt:result:<sid>` from offset 0.
 */
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RunAudioTranscriptService } from '../run-audio-transcript.service';

const TENANT = 't-1';
const RUN_ID = 'run-1';
const SESSION = 'stt-1';

interface Job {
  id: string;
  tenantId: string;
  status: string;
  completedAt: Date | null;
  resultCharCount: number | null;
  metaData: Record<string, unknown> | null;
}

const boundJob = (overrides: Partial<Job> = {}, boundAt = new Date().toISOString()): Job => ({
  id: 'job-1',
  tenantId: TENANT,
  status: 'PROCESSING',
  completedAt: null,
  resultCharCount: null,
  metaData: { owner: { type: 'apiKey', id: 'k' }, boundRun: { runId: RUN_ID, workflowSlug: 'dictate', versionNumber: 1, boundAt } },
  ...overrides,
});

type Entry = [string, string[]];
const seg = (id: string, fields: Record<string, string>): Entry => [id, Object.entries({ type: 'segment', ...fields }).flat()];
const final = (id: string, index: number, text: string, extra: Record<string, string> = {}) =>
  seg(id, { text, is_final: '1', utterance_index: String(index), start_time: String(index), end_time: String(index + 0.5), ...extra });

function setup(options: { jobs?: Job[]; snapshot?: unknown; maxSeconds?: number } = {}) {
  const jobs = { findAll: vi.fn(async () => options.jobs ?? [boundJob()]) };
  const redis = { eval: vi.fn(async () => (options.snapshot === undefined ? [1, 0, 0, []] : options.snapshot)) };
  const settings = { resolve: vi.fn(() => ({ value: options.maxSeconds ?? 3600 })) };
  const service = new RunAudioTranscriptService(jobs as never, redis as never, settings as never);
  return { service, jobs, redis, settings };
}

const read = (s: ReturnType<typeof setup>) => s.service.read({ tenantId: TENANT, sttSessionId: SESSION, runId: RUN_ID });

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  return 200;
}

describe('RunAudioTranscriptService.read — 404 (C5)', () => {
  it('unknown session, another tenant`s, unbound, or bound to another run: 404 and no Redis read', async () => {
    for (const jobs of [[], [boundJob({ tenantId: 't-2' })], [boundJob({ metaData: { owner: { type: 'apiKey', id: 'k' } } })], [boundJob({ metaData: { boundRun: { runId: 'run-2' } } })]]) {
      const s = setup({ jobs });
      expect(await status(read(s))).toBe(404);
      expect(s.redis.eval).not.toHaveBeenCalled();
    }
  });
});

describe('RunAudioTranscriptService.read — finals and state', () => {
  it('live: finals from offset 0 (partials, status, gloss and error frames skipped), joined with single spaces', async () => {
    const entries = [
      seg('1-0', { text: 'hel', is_final: '0', utterance_index: '0' }),
      final('2-0', 0, 'hello there', { speaker_id: 'spk_0', language: 'en' }),
      seg('3-0', { type: 'gloss', text: 'gloss', is_final: '1', utterance_index: '0' }),
      ['4-0', ['type', 'status', 'status', 'finalizing']] as Entry,
      ['5-0', ['type', 'error', 'message', 'oops']] as Entry,
      final('6-0', 1, '  how are you  '),
    ];
    const s = setup({ snapshot: [1, entries.length, entries.length, entries] });
    const result = await read(s);
    expect(result.state).toBe('live');
    expect(result.transcript).toBe('hello there how are you');
    expect(result.language).toBe('en');
    expect(result.finals).toEqual([
      { text: 'hello there', utteranceIndex: 0, start: 0, end: 0.5, speaker: 'spk_0', language: 'en' },
      { text: 'how are you', utteranceIndex: 1, start: 1, end: 1.5, speaker: null, language: null },
    ]);
    expect(s.redis.eval).toHaveBeenCalledWith(expect.stringContaining('XRANGE'), 1, `stt:result:${SESSION}`);
  });

  it('a second final for the same utterance (or its punctuated republish) replaces the first, in place', async () => {
    const entries = [final('1-0', 0, 'first take'), final('2-0', 1, 'second'), seg('3-0', { type: 'punctuated', text: 'First take.', utterance_index: '0' })];
    const result = await read(setup({ snapshot: [1, 3, 3, entries] }));
    expect(result.finals.map((f) => f.text)).toEqual(['First take.', 'second']);
  });

  it('ended: the job row is no longer live', async () => {
    const result = await read(setup({ jobs: [boundJob({ status: 'COMPLETED', completedAt: new Date() })], snapshot: [1, 1, 1, [final('1-0', 0, 'done')]] }));
    expect(result).toMatchObject({ state: 'ended', transcript: 'done' });
  });

  it('ended: the result stream carries the terminal `closed` status (the row update may lag)', async () => {
    const entries = [final('1-0', 0, 'done'), ['2-0', ['type', 'status', 'status', 'closed']] as Entry];
    expect((await read(setup({ snapshot: [1, 2, 2, entries] }))).state).toBe('ended');
  });

  it('live with no frames yet: an absent stream is simply empty', async () => {
    expect(await read(setup({ snapshot: [0, 0, 0, []] }))).toEqual({ state: 'live', language: null, transcript: '', finals: [] });
  });

  it('truncated: MAXLEN trimmed the head of the stream (entries-added > length), live or ended', async () => {
    expect((await read(setup({ snapshot: [1, 2, 5, [final('4-0', 3, 'late')]] }))).state).toBe('truncated');
    const ended = boundJob({ status: 'COMPLETED', completedAt: new Date() });
    expect((await read(setup({ jobs: [ended], snapshot: [1, 2, 5, [final('4-0', 3, 'late')]] }))).state).toBe('truncated');
  });

  it('truncated: the stream expired after the session ended and the row says (or cannot say) text was produced', async () => {
    for (const resultCharCount of [42, null]) {
      const ended = boundJob({ status: 'COMPLETED', completedAt: new Date(), resultCharCount });
      expect((await read(setup({ jobs: [ended], snapshot: [0, 0, 0, []] }))).state).toBe('truncated');
    }
  });

  it('ended and empty: the stream is gone and the row measured an empty transcript', async () => {
    const ended = boundJob({ status: 'COMPLETED', completedAt: new Date(), resultCharCount: 0 });
    expect(await read(setup({ jobs: [ended], snapshot: [0, 0, 0, []] }))).toEqual({ state: 'ended', language: null, transcript: '', finals: [] });
  });

  it('timeout: bound longer than workflowRuns.liveAudioMaxSeconds without ending', async () => {
    const boundAt = new Date(Date.now() - 601_000).toISOString();
    const s = setup({ jobs: [boundJob({}, boundAt)], maxSeconds: 600, snapshot: [1, 1, 1, [final('1-0', 0, 'still talking')]] });
    expect(await read(s)).toMatchObject({ state: 'timeout', transcript: 'still talking' });
    expect(s.settings.resolve).toHaveBeenCalledWith('workflowRuns.liveAudioMaxSeconds', TENANT);
    expect((await read(setup({ jobs: [boundJob({}, boundAt)], maxSeconds: 900 }))).state).toBe('live');
  });

  it('503 when the result stream cannot be read (Redis unavailable) — never a silently empty transcript', async () => {
    expect(await status(read(setup({ snapshot: null })))).toBe(503);
  });
});
