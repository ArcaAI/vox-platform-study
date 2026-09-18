/**
 * TASK-985 M-64 — the post-create Redis writes on `POST stream/session` are COMPENSATED.
 *
 * `createSession` admits a session on `apps/stt`: a GPU slot, a model pin and a capacity-guard
 * entry. The three writes that follow it — the stream ticket, the tenant/owner binding, the
 * session meta — used to run in a bare `Promise.all`, so a rejection propagated straight out of
 * the handler with nothing undone. The clinician got a 500 and the admitted STT session lived on
 * until STT's 300 s idle reaper, unreachable because the ticket it needed is exactly what failed
 * to mint.
 *
 * These cases pin the compensation, the flag it uses, and — the part that is easy to get wrong —
 * that the caller still sees the ORIGINAL error rather than a cleanup error that would send them
 * debugging the wrong hop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'platform-default' },
  models: { asr: { role: 'asr', slug: 'whisper', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', format: 'WHISPER_CPP', sourceUri: 'x' } },
  audioFrontEnd: {},
  decoding: {},
  postProcessing: {},
  streaming: {},
  instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'none', autoSwitch: false, switchAfterConsecutiveFailures: 3, spec: null },
};

const mocks = () => ({
  jobService: { create: vi.fn(), createBatchJob: vi.fn(), failJob: vi.fn(), getStatusCountsForOwner: vi.fn().mockResolvedValue({}) },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 }),
    removeSession: vi.fn().mockResolvedValue(undefined),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  pipelineService: { getById: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
  binding: {
    bind: vi.fn().mockResolvedValue(undefined),
    bindSessionMeta: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  sttConfig: { getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: null }), resolveProviderOverrides: vi.fn().mockResolvedValue({}) },
  asrResolver: { resolve: vi.fn().mockResolvedValue({ spec, providerOverrides: {}, fundingTier: 'platform' }) },
});

function build() {
  const m = mocks();
  const controller = new TranscriptionJobController(
    m.jobService as never,
    m.realtimeService as never,
    m.sessionService as never,
    m.cls as never,
    m.blobStorage as never,
    m.tenantBucketService as never,
    m.pipelineService as never,
    m.streamTicketService as never,
    m.binding as never,
    m.entitlements as never,
    m.sttConfig as never,
    undefined,
    m.asrResolver as never,
  );
  return { controller, m };
}

const res = () => ({ setHeader: vi.fn() });

beforeEach(() => vi.clearAllMocks());

describe('TASK-985 M-64 — post-create compensation on createStreamSession', () => {
  it('a failed ticket mint tears the admitted STT session down as interrupted, and rethrows the ORIGINAL error', async () => {
    const { controller, m } = build();
    const boom = new Error('ticket mint failed');
    m.streamTicketService.issueTicket.mockRejectedValueOnce(boom);

    await expect(controller.createStreamSession({} as never, res() as never)).rejects.toBe(boom);

    // `interrupted: true` is the correct flag — the session was aborted before it served a
    // single frame. It bills nothing: `usageSegments` drops zero-duration segments.
    expect(m.sessionService.removeSession).toHaveBeenCalledWith('sess-1', true, 'tenant-1');
  });

  it('a failed binding write compensates too — the rejection can come from ANY of the three', async () => {
    const { controller, m } = build();
    m.binding.bind.mockRejectedValueOnce(new Error('redis blip'));

    await expect(controller.createStreamSession({} as never, res() as never)).rejects.toThrow('redis blip');

    expect(m.sessionService.removeSession).toHaveBeenCalledWith('sess-1', true, 'tenant-1');
  });

  it('clears the tenant binding as well, so no ticket can be minted against the dead session', async () => {
    const { controller, m } = build();
    m.binding.bindSessionMeta.mockRejectedValueOnce(new Error('meta write failed'));

    await expect(controller.createStreamSession({} as never, res() as never)).rejects.toThrow('meta write failed');

    // A half-written binding is a session id that can still mint a stream ticket against an
    // upstream that no longer exists — the false-resume path F-06 exists to close.
    expect(m.binding.clear).toHaveBeenCalledWith('sess-1');
  });

  it('a compensation that ITSELF fails does not mask the original error', async () => {
    // The caller must be told what actually went wrong. Surfacing the cleanup failure instead
    // would send an operator to debug STT teardown when the real fault was the ticket mint.
    const { controller, m } = build();
    const original = new Error('ticket mint failed');
    m.streamTicketService.issueTicket.mockRejectedValueOnce(original);
    m.sessionService.removeSession.mockRejectedValueOnce(new Error('stt unreachable'));
    m.binding.clear.mockRejectedValueOnce(new Error('redis down'));

    await expect(controller.createStreamSession({} as never, res() as never)).rejects.toBe(original);
  });

  it('the happy path compensates nothing', async () => {
    const { controller, m } = build();

    await controller.createStreamSession({} as never, res() as never);

    expect(m.sessionService.removeSession).not.toHaveBeenCalled();
    expect(m.binding.clear).not.toHaveBeenCalled();
  });
});
