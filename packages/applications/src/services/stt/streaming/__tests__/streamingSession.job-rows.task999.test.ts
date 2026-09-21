/**
 * TASK-999 (D-5(a)) — a realtime session is a `TranscriptionJob` row.
 *
 * Before this ticket a streaming session was never written to Postgres at all: it
 * lived in Redis (`stt:session:{id}`, 24 h TTL) plus the `AiUsageEvent` rows
 * written at teardown, so the admin job list could only ever show BATCH rows, and
 * `TranscriptionJobType.STREAMING` / `createStreamingJob` were dead code.
 */
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streamingSession.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const configWithSttUrl = (url: string): any => ({ config: { STT_URL: url } });

const resolvedSpec = (): any => ({
  runtimeKey: 'agent-v1',
  schemaVersion: 1,
  agent: { slug: 'ml-en-consult', versionId: 'agent-version-1', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper-ml-en-f16', taskType: 'SPEECH_TO_TEXT', format: 'GGUF', provider: null, libraryName: 'whisper.cpp' } },
  fallback: {
    kind: 'model',
    autoSwitch: true,
    switchAfterConsecutiveFailures: 3,
    chain: [
      {
        runtimeKey: 'agent-v1:fallback',
        agent: { slug: 'cloud-fallback', versionId: 'agent-version-2', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
        models: { asr: { role: 'asr', slug: 'sarvam-saarika-v2', taskType: 'SPEECH_TO_TEXT', format: 'API', provider: 'sarvam' } },
      },
    ],
    spec: null,
  },
});

const openRequest = (): any => ({
  sessionId: 'sess-1',
  tenantId: 'tenant-1',
  pipelineId: 'agent-v1',
  consultationId: 'consult-1',
  userId: 'doctor-1',
  resolvedSpec: resolvedSpec(),
});

const summary = (overrides: Record<string, unknown> = {}): any => ({
  session_id: 'sess-1',
  tenant_id: 'tenant-1',
  consultation_id: 'consult-1',
  user_id: 'doctor-1',
  pipeline_id: 'agent-v1',
  closed_at: '2026-09-22T10:01:30',
  audio_seconds: 42.5,
  session_seconds: 90,
  engine: 'whisper_cpp',
  deployment: 'SELF_HOSTED',
  language_mode: 'ml-en',
  ...overrides,
});

describe('TASK-999 — realtime sessions become TranscriptionJob rows', () => {
  let httpService: any;
  let ledger: { recordUsage: ReturnType<typeof vi.fn> };
  let jobs: { createForStreamSession: ReturnType<typeof vi.fn>; completeStreamSessionJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    jobs = {
      createForStreamSession: vi.fn().mockResolvedValue({ id: 'job-1' }),
      completeStreamSessionJob: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        resolvedSpec: resolvedSpec(),
        servedBy: { chainIndex: -1, source: 'primary', agentSlug: 'ml-en-consult', modelSlug: 'whisper-ml-en-f16', provider: null, engine: 'whisper_cpp' },
        alreadyCompleted: false,
      }),
    };
  });

  // Positional construction: the job service is the eighth (optional, trailing)
  // dependency, so every existing fixture keeps its arity.
  const build = () =>
    new StreamingSessionService(
      httpService,
      configWithSttUrl('http://stt.internal:9000'),
      ledger as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jobs as any,
    );

  it('writes exactly ONE row, keyed to the STT session, when a session opens', async () => {
    // RED before the change: `createSession` never touched Postgres, so a live
    // session had no row at all and `jobType = STREAMING` was unreachable.
    httpService.post.mockReturnValue(of({ status: 201, data: { session_id: 'sess-1', status: 'active' } }));

    await build().createSession(openRequest());

    expect(jobs.createForStreamSession).toHaveBeenCalledTimes(1);
    expect(jobs.createForStreamSession.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      streamSessionId: 'sess-1',
      consultationId: 'consult-1',
      // Read off the spec the gateway already resolved, so a STREAMING row
      // answers "which agent ran this" the same way a BATCH row does.
      agentVersionId: 'agent-version-1',
      userId: 'doctor-1',
    });
  });

  it('opens the session anyway when the row cannot be written', async () => {
    // RED before the change: there was no row write to fail. The point of the
    // test is the posture — bookkeeping for an admin screen must never be able to
    // fail a live consultation.
    httpService.post.mockReturnValue(of({ status: 201, data: { session_id: 'sess-1', status: 'active' } }));
    jobs.createForStreamSession.mockRejectedValue(new Error('connection pool exhausted'));

    const status = await build().createSession(openRequest());

    expect(status).toMatchObject({ sessionId: 'sess-1', status: 'active' });
  });

  it('writes no row when the session never opened', async () => {
    // At capacity → `createSession` answers null. A row for a session that does
    // not exist would be a phantom in the job list.
    httpService.post.mockReturnValue(throwError(() => ({ response: { status: 503, data: { detail: 'at capacity' } } })));

    await expect(build().createSession(openRequest())).resolves.toBeNull();
    expect(jobs.createForStreamSession).not.toHaveBeenCalled();
  });

  it('teardown COMPLETES the same row rather than creating a second one', async () => {
    // RED before the change: teardown emitted usage rows and nothing else — there
    // was no row to complete, and no record of which chain entry had served.
    httpService.delete.mockReturnValue(of({ status: 200, data: summary() }));

    await build().removeSession('sess-1', false, 'tenant-1');

    expect(jobs.createForStreamSession).not.toHaveBeenCalled();
    expect(jobs.completeStreamSessionJob).toHaveBeenCalledTimes(1);
    expect(jobs.completeStreamSessionJob).toHaveBeenCalledWith('sess-1', { engine: 'whisper_cpp' });
  });

  it('completes on the engine the session ENDED on when it switched mid-flight', async () => {
    // Segments arrive in first-appearance order, so the last billable one is what
    // was serving at close — which is what `servedBy` has to mean for a session.
    httpService.delete.mockReturnValue(
      of({
        status: 200,
        data: summary({
          segments: [
            { engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 20, session_seconds: 30 },
            { engine: 'sarvam', deployment: 'CLOUD', audio_seconds: 22.5, session_seconds: 60 },
          ],
        }),
      }),
    );

    await build().removeSession('sess-1', false, 'tenant-1');

    expect(jobs.completeStreamSessionJob).toHaveBeenCalledWith('sess-1', { engine: 'sarvam' });
  });

  it('stamps the real ASR model on each streaming usage row', async () => {
    // RED before the change: `model: null` was a hardcoded literal on this row, so
    // no streaming spend could be attributed to a model on a cost surface. The
    // model comes from the session's own `resolvedSpec`, which only the row carries
    // at teardown.
    httpService.delete.mockReturnValue(
      of({
        status: 200,
        data: summary({
          segments: [
            { engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 20, session_seconds: 30 },
            { engine: 'sarvam', deployment: 'CLOUD', audio_seconds: 22.5, session_seconds: 60 },
          ],
        }),
      }),
    );

    await build().removeSession('sess-1', false, 'tenant-1');

    const models = ledger.recordUsage.mock.calls.map((call) => call[0].common.model);
    expect(models).toContain('whisper-ml-en-f16');
    expect(models).toContain('sarvam-saarika-v2');
  });

  it('still bills, with model null, when there is no row to read a spec from', async () => {
    // A session opened before this shipped (or whose row write failed) must meter
    // exactly as it did before — never fail, never guess a model.
    jobs.completeStreamSessionJob.mockResolvedValue(null);
    httpService.delete.mockReturnValue(of({ status: 200, data: summary() }));

    await build().removeSession('sess-1', false, 'tenant-1');

    expect(ledger.recordUsage).toHaveBeenCalledTimes(1);
    expect(ledger.recordUsage.mock.calls[0][0].common.model).toBeNull();
  });

  it('tears the session down anyway when the row cannot be closed', async () => {
    // Three of the four teardown callers treat a throw as retryable, so a failure
    // here would re-run a teardown that had already succeeded.
    jobs.completeStreamSessionJob.mockRejectedValue(new Error('deadlock detected'));
    httpService.delete.mockReturnValue(of({ status: 200, data: summary() }));

    await expect(build().removeSession('sess-1', false, 'tenant-1')).resolves.toBeUndefined();
    expect(ledger.recordUsage).toHaveBeenCalledTimes(1);
  });
});
