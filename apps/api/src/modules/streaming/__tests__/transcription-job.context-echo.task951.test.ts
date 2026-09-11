/**
 * TASK-951 R2 (D-8) — `POST audio/transcription-jobs/stream/session` accepts a schema-validated
 * `context`, stores it on the session binding, and echoes it with a session epoch.
 *
 * This is the ACCEPT side of the echo. What the gateway takes here is what every transcript of
 * the session will carry (`stt-ws.gateway.context-echo.task951.test.ts` for the attach,
 * `session-context-echo.task951.test.ts` in `@arcaai/applications` for the wire), so the two
 * refusals matter as much as the happy path:
 *
 *  · **413 `CONTEXT_TOO_LARGE`** — the object is stored for the session's lifetime and re-sent on
 *    every utterance, so its cost is paid per segment. It is refused, never truncated: a client
 *    that read back a silently shortened `mic_id` would mis-attribute speech and never know.
 *  · **400 `CONTEXT_SCHEMA_VIOLATION`** — when the resolved ASR agent BINDS a context schema, the
 *    object is checked against the schema FROZEN into that agent at publish time, the same
 *    artifact the agent invocation plane checks against. One published vocabulary, one answer.
 *
 * An agent that binds NO schema declares no vocabulary and therefore refuses nothing — the size
 * bound is the whole gate. That mirrors `AgentInvocationService.contextProblems` returning `[]`
 * for the same case: "no opinion" must never read as "everything is invalid".
 */
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';
import { MAX_STREAM_SESSION_CONTEXT_BYTES } from '../dto';

/** Minimal `ResolvedAsrSpec` — only the fields `createStreamSession` reads. */
const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'realtime-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper' } },
  audioFrontEnd: {},
  decoding: {},
  postProcessing: {},
  streaming: {},
  instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'none', autoSwitch: false, switchAfterConsecutiveFailures: 3, spec: null },
};

/**
 * The envelope `payloadSchemaFromDefinition` produces for a schema whose only STRUCTURED kind is
 * `stream` — `additionalProperties: false`, one property per kind.
 */
const STREAM_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    audio_stream: { type: 'object' },
    stream: {
      type: 'object',
      properties: { mic_id: { type: 'string', minLength: 1 }, speaker_label: { type: 'string' } },
      required: ['mic_id'],
      additionalProperties: true,
    },
  },
};

const CONTEXT = { stream: { mic_id: 'mic-1', speaker_label: 'Clinician' } };

const mocks = (contextSchema?: unknown) => ({
  jobService: { getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0 }) },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 }),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null) },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByPurpose: vi.fn() },
  pipelineService: { getById: vi.fn().mockResolvedValue({ id: 'pipe-1', tenantId: 'tenant-1' }) },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
  binding: { bind: vi.fn(), bindSessionMeta: vi.fn(), clear: vi.fn() },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  asrResolver: {
    resolve: vi.fn().mockResolvedValue({
      spec,
      ...(contextSchema ? { contextSchema: { schemaId: 'cs-1', versionNumber: 3, versionId: 'csv-1', payloadSchema: contextSchema } } : {}),
    }),
  },
});

function build(contextSchema?: unknown) {
  const m = mocks(contextSchema);
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
    undefined,
    undefined,
    m.asrResolver as never,
  );
  return { controller, m };
}

const res = () => ({ setHeader: vi.fn() });

beforeEach(() => vi.clearAllMocks());

describe('createStreamSession — accepting the session context', () => {
  it('stores the context on the session binding and echoes it back with a session epoch', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);
    const before = Date.now();

    const out = await controller.createStreamSession({ agentSlug: 'realtime-transcription', context: CONTEXT } as never, res() as never);

    // Stored beside the sampleRate on the ONE meta record the WS gateway reads at handshake.
    expect(m.binding.bindSessionMeta).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ sampleRate: 16000, context: CONTEXT, sessionEpochMs: expect.any(Number) }),
    );
    // Echoed on the create response, so a client confirms what it will see without waiting for
    // the first utterance.
    expect(out.context).toEqual(CONTEXT);
    expect(out.sessionEpochMs).toBeGreaterThanOrEqual(before);

    // ONE epoch: the value told to the client and the value stored must be the same number, or a
    // caller aligning several sessions would be aligning against a clock nothing echoes.
    const stored = m.binding.bindSessionMeta.mock.calls[0][1] as { sessionEpochMs: number };
    expect(out.sessionEpochMs).toBe(stored.sessionEpochMs);
  });

  it('never forwards the context to apps/stt — the echo is a gateway concern end to end', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);

    await controller.createStreamSession({ agentSlug: 'realtime-transcription', context: CONTEXT } as never, res() as never);

    expect(m.sessionService.createSession.mock.calls[0][0]).not.toHaveProperty('context');
  });

  it('a session created WITHOUT a context is unchanged — no context stored, none echoed', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);

    const out = await controller.createStreamSession({ agentSlug: 'realtime-transcription' } as never, res() as never);

    expect(m.binding.bindSessionMeta.mock.calls[0][1]).not.toHaveProperty('context');
    expect(out.context).toBeUndefined();
    // The epoch is always recorded: every session has a creation instant, and a client that later
    // adds a context must not have to re-open the session to get a clock.
    expect(out.sessionEpochMs).toEqual(expect.any(Number));
  });

  it('refuses a context over the 4 KB bound with 413 CONTEXT_TOO_LARGE, before any STT or bucket I/O', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);
    const oversized = { stream: { mic_id: 'm', note: 'x'.repeat(MAX_STREAM_SESSION_CONTEXT_BYTES) } };

    await expect(
      controller.createStreamSession({ agentSlug: 'realtime-transcription', context: oversized } as never, res() as never),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    // The size gate needs no tenant read, no agent resolution and no upstream round trip, so an
    // oversized body must not consume any of them.
    expect(m.entitlements.assertConcurrencyQuota).not.toHaveBeenCalled();
    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('measures the bound in UTF-8 BYTES, so a multi-byte payload cannot slip past a character count', async () => {
    const { controller } = build(STREAM_PAYLOAD_SCHEMA);
    // Malayalam codepoints are 3 bytes each in UTF-8: ~1500 characters, ~4500 bytes. A `.length`
    // check would admit this.
    const multiByte = { stream: { mic_id: 'm', note: 'മ'.repeat(1500) } };
    expect(JSON.stringify(multiByte).length).toBeLessThan(MAX_STREAM_SESSION_CONTEXT_BYTES);

    await expect(
      controller.createStreamSession({ agentSlug: 'realtime-transcription', context: multiByte } as never, res() as never),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('refuses a context the bound schema does not admit with 400 CONTEXT_SCHEMA_VIOLATION + the problems', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);

    // `mic_id` is required by the kind's own schema.
    const promise = controller.createStreamSession(
      { agentSlug: 'realtime-transcription', context: { stream: { speaker_label: 'Clinician' } } } as never,
      res() as never,
    );

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await promise.catch((err: BadRequestException) => {
      const body = err.getResponse() as { code: string; problems: string[]; message: string };
      expect(body.code).toBe('CONTEXT_SCHEMA_VIOLATION');
      expect(body.problems.length).toBeGreaterThan(0);
      // The message names the agent and the schema VERSION, because the frozen artifact — not the
      // tenant's current schema row — is what refused the request.
      expect(body.message).toContain('realtime-transcription');
      expect(body.message).toContain('version 3');
    });

    // Refused BEFORE the upstream session exists, so nothing is left behind in STT.
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind key — the envelope is closed, so a typo is caught, not silently echoed', async () => {
    const { controller } = build(STREAM_PAYLOAD_SCHEMA);

    await expect(
      controller.createStreamSession({ agentSlug: 'realtime-transcription', context: { streem: { mic_id: 'm' } } } as never, res() as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an agent that binds NO schema accepts any object within the size bound', async () => {
    const { controller, m } = build(/* contextSchema */ undefined);

    const out = await controller.createStreamSession(
      { agentSlug: 'realtime-transcription', context: { anything: { at: 'all' } } } as never,
      res() as never,
    );

    expect(out.context).toEqual({ anything: { at: 'all' } });
    expect(m.binding.bindSessionMeta).toHaveBeenCalledWith('sess-1', expect.objectContaining({ context: { anything: { at: 'all' } } }));
  });

  it('the deprecated pipelineId path accepts a context on the size bound alone — it resolves no agent to ask', async () => {
    const { controller, m } = build(STREAM_PAYLOAD_SCHEMA);

    const out = await controller.createStreamSession({ pipelineId: 'pipe-1', context: { anything: 1 } } as never, res() as never);

    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(out.context).toEqual({ anything: 1 });
  });
});
