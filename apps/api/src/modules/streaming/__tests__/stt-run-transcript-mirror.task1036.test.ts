/**
 * TASK-1036 (lane B6b, §10.3) — live transcripts reach the run they feed.
 *
 * When an STT streaming session is bound to a consultation that is the subject of a RUNNING
 * workflow run — a sandbox run recording from the console Test tab, or the consultation's governed
 * run — the gateway's STT bridge appends each `transcript.partial` / `transcript.final` to that run
 * through the ONE sequencer (`RunEventStreamHub.append`). They are admin-plane events with no
 * `nodeId` (protocol-v2.md §4: the consultation session is the source). Best-effort: a lookup or
 * append failure never touches the live transcript the clinician sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttRunTranscriptMirror } from '../stt-run-transcript-mirror';

const TENANT = '10000000-0000-0000-0000-000000000001';
const SESSION = 'stt-session-1';
const CONSULTATION = 'consultation-1';

function build(options: { consultationId?: string | null; sandboxRuns?: string[]; governing?: Record<string, unknown> | null; tenantId?: string } = {}) {
  const hub = { available: vi.fn(() => true), append: vi.fn().mockResolvedValue({ seq: 1, streamId: '1-0', duplicate: false }) };
  const jobs = {
    findAll: vi.fn().mockResolvedValue(options.consultationId === null ? [] : [{ tenantId: TENANT, consultationId: options.consultationId ?? CONSULTATION }]),
  };
  const consultations = {
    findByIdOrNull: vi.fn().mockResolvedValue({
      id: CONSULTATION,
      tenantId: options.tenantId ?? TENANT,
      metadata: options.governing === undefined ? null : options.governing,
    }),
  };
  const runs = { findAll: vi.fn().mockResolvedValue((options.sandboxRuns ?? []).map((runId) => ({ runId }))) };
  const mirror = new SttRunTranscriptMirror(hub as never, jobs as never, consultations as never, runs as never);
  return { mirror, hub, jobs, consultations, runs };
}

const appended = (hub: { append: ReturnType<typeof vi.fn> }) => hub.append.mock.calls.map((call) => call[0] as Record<string, unknown>);

beforeEach(() => vi.clearAllMocks());

describe('SttRunTranscriptMirror', () => {
  it('appends a partial and a final to the running sandbox run, with no nodeId, in arrival order', async () => {
    const { mirror, hub, runs } = build({ sandboxRuns: ['run-s'] });
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: false, text: 'chest pa', utteranceIndex: 0, stableChars: 5, startTime: 0, endTime: 1 });
    mirror.mirror(TENANT, SESSION, {
      type: 'transcript',
      isFinal: true,
      text: 'chest pain',
      utteranceIndex: 0,
      startTime: 0.5,
      endTime: 1.75,
      speakerLabel: 'Speaker 1',
      language: 'en',
      wordTimestamps: [{ word: 'chest', start: 0, end: 1, confidence: 1 }],
    });
    await mirror.idle(SESSION);

    const events = appended(hub);
    expect(events.map((e) => e.type)).toEqual(['transcript.partial', 'transcript.final']);
    expect(events[0]).toMatchObject({ runId: 'run-s', data: { text: 'chest pa', utteranceIndex: 0, stableChars: 5 } });
    expect(events[1]).toMatchObject({
      runId: 'run-s',
      data: { text: 'chest pain', utteranceIndex: 0, start: 0.5, end: 1.75, speaker: 'Speaker 1', language: 'en' },
    });
    for (const event of events) {
      expect(event.nodeId).toBeUndefined();
      expect(typeof event.ts).toBe('string');
    }
    // Only the protocol's closed fields — no word timings, no context echo.
    expect(Object.keys(events[1].data as object).sort()).toEqual(['end', 'language', 'speaker', 'start', 'text', 'utteranceIndex']);
    // The sandbox query is tenant-scoped, RUNNING-only and keyed on the bound consultation.
    expect(runs.findAll).toHaveBeenCalledWith({
      where: { tenantId: TENANT, isSandbox: true, status: 'RUNNING', metaData: { path: ['consultationId'], equals: CONSULTATION } },
    });
  });

  it('appends to the consultation`s governed run while it is running', async () => {
    const { mirror, hub } = build({ governing: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-g', workflowDefinitionSlug: 'flow' } } });
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'hello', startTime: 0, endTime: 1 });
    await mirror.idle(SESSION);
    expect(appended(hub).map((e) => e.runId)).toEqual(['run-g']);
  });

  it('ignores a governed run that already ended', async () => {
    const { mirror, hub } = build({
      governing: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-g', workflowDefinitionSlug: 'flow', runStatus: 'COMPLETED' } },
    });
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'hello', startTime: 0, endTime: 1 });
    await mirror.idle(SESSION);
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('resolves the session`s runs once per refresh window, not per transcript', async () => {
    const { mirror, jobs } = build({ sandboxRuns: ['run-s'] });
    for (let i = 0; i < 5; i++) mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: false, text: `p${i}`, startTime: 0, endTime: 1 });
    await mirror.idle(SESSION);
    expect(jobs.findAll).toHaveBeenCalledTimes(1);
  });

  it('a session bound to no consultation, or to another tenant`s, appends nothing', async () => {
    const unbound = build({ consultationId: null });
    unbound.mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'x', startTime: 0, endTime: 1 });
    await unbound.mirror.idle(SESSION);
    expect(unbound.hub.append).not.toHaveBeenCalled();

    const foreign = build({ tenantId: 'other-tenant', sandboxRuns: ['run-s'] });
    foreign.mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'x', startTime: 0, endTime: 1 });
    await foreign.mirror.idle(SESSION);
    expect(foreign.hub.append).not.toHaveBeenCalled();
  });

  it('skips non-transcripts, glosses, empty text and a tenant-less session without any lookup', async () => {
    const { mirror, hub, jobs } = build({ sandboxRuns: ['run-s'] });
    mirror.mirror(TENANT, SESSION, { type: 'status', status: 'ready' });
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'hola', resultType: 'gloss', startTime: 0, endTime: 1 });
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: '   ', startTime: 0, endTime: 1 });
    mirror.mirror(null, SESSION, { type: 'transcript', isFinal: true, text: 'x', startTime: 0, endTime: 1 });
    await mirror.idle(SESSION);
    expect(jobs.findAll).not.toHaveBeenCalled();
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('never throws: a failed lookup is swallowed and nothing is appended', async () => {
    const { mirror, hub, jobs } = build({ sandboxRuns: ['run-s'] });
    jobs.findAll.mockRejectedValue(new Error('db down'));
    expect(() => mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'x', startTime: 0, endTime: 1 })).not.toThrow();
    await mirror.idle(SESSION);
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('does nothing at all when the run-event transport is unavailable', async () => {
    const { mirror, hub, jobs } = build({ sandboxRuns: ['run-s'] });
    hub.available.mockReturnValue(false);
    mirror.mirror(TENANT, SESSION, { type: 'transcript', isFinal: true, text: 'x', startTime: 0, endTime: 1 });
    await mirror.idle(SESSION);
    expect(jobs.findAll).not.toHaveBeenCalled();
  });
});

describe('SttWsGateway hands every relayed frame to the mirror', () => {
  it('calls mirror(tenant, session, frame) for each result on the caption reader', async () => {
    const { Subject } = await import('rxjs');
    const { Logger } = await import('@nestjs/common');
    const { SttWsGateway } = await import('../stt-ws.gateway');
    for (const level of ['log', 'warn', 'error', 'debug'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => {});
    const results = new Subject<Record<string, unknown>>();
    const bridge = {
      connect: vi.fn(),
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
      subscribeToResults: vi.fn().mockReturnValue(results.asObservable()),
      unsubscribeFromResults: vi.fn(),
    };
    const binding = {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(TENANT),
      lookupBinding: vi.fn().mockResolvedValue({ tenantId: TENANT, userId: 'user-1' }),
      lookupSessionMeta: vi.fn().mockResolvedValue(null),
      lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
      bindMetadataMarks: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const tickets = {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn().mockResolvedValue({ userId: 'user-1', tenantId: TENANT, scope: `stt_session:${SESSION}`, exp: Date.now() + 30_000, impersonatedBy: null }),
    };
    const mirror = { mirror: vi.fn(), forget: vi.fn() };
    const gateway = new SttWsGateway(
      { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) } as never,
      bridge as never,
      tickets as never,
      binding as never,
      { enqueue: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mirror as never,
    );
    const client = { send: vi.fn(), close: vi.fn(), on: vi.fn(), readyState: 1, OPEN: 1 };
    await gateway.handleConnection(client as never, { url: `/ws/stt/stream?sessionId=${SESSION}&ticket=t` } as never);

    const frame = { type: 'transcript', isFinal: true, text: 'chest pain', startTime: 0, endTime: 1 };
    results.next(frame);

    expect(mirror.mirror).toHaveBeenCalledWith(TENANT, SESSION, expect.objectContaining({ text: 'chest pain', isFinal: true }));
  });
});
