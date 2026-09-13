/**
 * The ASR agent's transcript carries the timing that ties it to the audio.
 *
 * ## The defect
 *
 * `attachSttStream` subscribed to the STT result stream and read exactly ONE field off each
 * frame: `msg.text`. `StreamingTranscriptMessage` carries `startTime`, `endTime`,
 * `utteranceIndex`, `speakerLabel`/`speakerId`, `speakerConfidence`, `detectedLanguage`,
 * `stableChars`, `resultType`, `pipelineId` and `wordTimestamps` — every one of them was dropped
 * at that line, so `LiveSession.transcriptParts` was a `string[]` and the `core.agent`
 * SPEECH_TO_TEXT node published `{ transcript: <blob>, pipelineId }`.
 *
 * That made the transcription agent's declared output contract unsatisfiable. Nothing downstream
 * could say WHEN an utterance was spoken, WHO said it, or which stretch of audio it came from,
 * and no consumer could reconcile a transcript with the audio that produced it. The agent's
 * `outputSchema` said `transcript` was an array of timed segments; no runtime had ever emitted
 * one.
 *
 * ## What this file pins
 *
 *  1. The correlation SURVIVES the trip from the STT frame to the capture node's output.
 *  2. The offsets are exact BY CONSTRUCTION: `transcript.slice(charStart, charEnd)` is the
 *     segment's own text, in the string the node actually published — which is the DELTA on
 *     every flush but the first.
 *  3. The capture anchor makes the producer-relative clock absolute, and the arithmetic holds:
 *     an utterance ends before this service receives it.
 *  4. An untimed ingest contributes its words and NO segment. A fabricated `start: 0` would be
 *     worse than a missing measurement.
 *
 * Observed through `persistLiveHandoff` — the real seam the durable finalizer reads the live
 * lane's node outputs from — rather than through a reached-into private.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-timing';
const STT_SESSION = 'stt-session-1';
/**
 * A well-formed TURN response against `SOAP_NOTE_SHAPE` — the platform template the live loop
 * falls open to with no `documentTemplateService` wired.
 *
 * It has to parse: a flush that produces no sections does not advance
 * `flushedTranscriptCount`, and an unadvanced cursor means every flush publishes the WHOLE
 * transcript. The delta case below would then never be reached, and would pass for the wrong
 * reason.
 */
const TURN = JSON.stringify({ subjective: { addition: 'Cough since monday.' } });

/** The capture node of `PLATFORM_REALTIME_LANE` — the SPEECH_TO_TEXT `core.agent`. */
const CAPTURE_NODE_ID = 'capture';

type TranscriptFrame = Record<string, unknown>;

/** A minimal hot Observable: `subscribe()` hands back an unsubscribe, `emit()` pushes a frame. */
function resultStream() {
  const listeners: Array<(msg: TranscriptFrame) => void> = [];
  return {
    emit(msg: TranscriptFrame) {
      for (const next of [...listeners]) next(msg);
    },
    bridge: {
      subscribeToResults: vi.fn(() => ({
        subscribe: (handlers: { next: (msg: TranscriptFrame) => void }) => {
          listeners.push(handlers.next);
          return { unsubscribe: vi.fn() };
        },
      })),
    },
  };
}

/** One FINAL transcript frame, shaped exactly as `StreamingTranscriptMessage` reaches the bridge. */
const frame = (over: Partial<TranscriptFrame> & { text: string; startTime: number; endTime: number }): TranscriptFrame => ({
  type: 'transcript',
  isFinal: true,
  ...over,
});

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-08-28T00:00:00.000Z',
});

function buildService() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [], vitals: {} } });
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: TURN } });
    return Promise.resolve({ data: {} });
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };
  const cache = cacheMock();
  const stream = resultStream();

  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    stream.bridge as never,
    {
      create: vi.fn(async (entity: { id?: string }) => ({ ...entity, id: 'ctx-1' })),
      update: vi.fn(async () => ({ id: 'ctx-1' })),
      findTranscripts: vi.fn(async () => []),
      findPreSummaries: vi.fn(async () => []),
      findLatestPreSummary: vi.fn(async () => null),
      findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
      encryptContentIntoEntity: vi.fn(),
    } as never,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: ARCAAI, metadata: null })) } as never,
    // No tenant assignment ⇒ the code-built PLATFORM_REALTIME_LANE, whose stage 0 is the
    // SPEECH_TO_TEXT capture node this file is about.
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: null, source: 'platform-default' })) } as never,
    { findPublishedBySlug: vi.fn(async () => null) } as never,
  );

  return { service, stream, cache };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The capture node's published output, read out of the live handoff `stop()` writes. */
function captureOutput(cache: ReturnType<typeof cacheMock>): Record<string, unknown> {
  const handoff = cache.setex.mock.calls.find(([key]) => String(key).includes('handoff'));
  expect(handoff, 'stop() must write a live handoff record').toBeDefined();
  const record = JSON.parse(String(handoff![2])) as { outputs: Record<string, Record<string, unknown>> };
  const output = record.outputs[CAPTURE_NODE_ID];
  expect(output, `the handoff must carry ${CAPTURE_NODE_ID}`).toBeDefined();
  return output;
}

describe('the live ASR agent publishes per-utterance timing, not a bare string', () => {
  it('carries every correlation field off the STT frame onto the capture node’s segments', async () => {
    const { service, stream, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    stream.emit(
      frame({
        text: 'cough since monday',
        startTime: 1.25,
        endTime: 2.5,
        utteranceIndex: 0,
        speakerLabel: 'Speaker 0',
        speakerId: 'SPEAKER_00',
        speakerConfidence: 0.82,
        detectedLanguage: 'ml-IN',
        stableChars: 4,
        resultType: 'segment',
        pipelineId: 'pipeline-7',
        wordTimestamps: [
          { word: 'cough', start: 1.25, end: 1.6, confidence: 0.91 },
          { word: 'since', start: 1.6, end: 1.9, confidence: null },
        ],
      }),
    );
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const output = captureOutput(cache);
    const segments = output.segments as Array<Record<string, unknown>>;
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      text: 'cough since monday',
      start: 1.25,
      end: 2.5,
      isFinal: true,
      utteranceIndex: 0,
      // The bridge's anonymous label wins over the raw diarization cluster — one speaker field,
      // so a consumer never has to guess which one identifies.
      speaker: 'Speaker 0',
      speakerConfidence: 0.82,
      // What was SPOKEN, not the session's configured mode.
      language: 'ml-IN',
      stableChars: 4,
      pipelineId: 'pipeline-7',
    });
    // `{ word, ... }` on the wire becomes `{ text, ... }` here; a null confidence (Whisper
    // reports none) is DROPPED, never coerced to 0 — which reads as "certainly wrong".
    expect(segments[0].words).toEqual([
      { text: 'cough', start: 1.25, end: 1.6, confidence: 0.91 },
      { text: 'since', start: 1.6, end: 1.9 },
    ]);
    // The declared `data` socket carries the same structure the top-level keys do.
    expect((output.data as { segments: unknown[] }).segments).toEqual(segments);
  });

  it('offsets resolve in the string the node published — which is the DELTA, not the session transcript', async () => {
    const { service, stream, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    stream.emit(frame({ text: 'cough since monday', startTime: 0, endTime: 2 }));
    await service.flush(CID);

    // A SECOND utterance, flushed by `stop()`'s drain. The capture node publishes only what the
    // cursor has not covered, so this turn's `transcript` is "no fever" alone — and a segment
    // built against the SESSION transcript would carry `charStart: 19`, pointing past the end of
    // the 8-character string the node actually published.
    stream.emit(frame({ text: 'no fever', startTime: 2.5, endTime: 3.25, utteranceIndex: 1 }));
    await service.stop(CID, { persistSnapshot: false });

    const output = captureOutput(cache);
    const transcript = output.transcript as string;
    const segments = output.segments as Array<{ text: string; charStart: number; charEnd: number }>;

    expect(transcript).toBe('no fever');
    expect(segments).toHaveLength(1);
    expect(segments[0].charStart).toBe(0);
    expect(transcript.slice(segments[0].charStart, segments[0].charEnd)).toBe('no fever');
  });

  it('anchors the producer clock: epochMs + end never leads the moment the segment arrived', async () => {
    const { service, stream, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    stream.emit(frame({ text: 'cough since monday', startTime: 0, endTime: 0.5 }));
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const output = captureOutput(cache);
    const audio = output.audio as { kind: string; sessionId: string; epochMs: number };
    const [segment] = output.segments as Array<{ end: number; receivedAtMs: number }>;

    expect(audio.kind).toBe('stream');
    expect(audio.sessionId).toBe(STT_SESSION);
    // Without this anchor `start`/`end` are a producer-relative measurement and a caller cannot
    // line them up against audio it sent. With it, `epochMs + end * 1000` is when the utterance
    // ended in wall-clock terms and the speech-to-transcript lag is a subtraction.
    expect(audio.epochMs).toBeGreaterThan(0);
    // The anchor is stamped at ATTACH, so it cannot postdate any segment that arrived on the
    // stream. This is the half that holds for a synthetic frame; the stronger
    // `epochMs + end * 1000 <= receivedAtMs` is a property of audio streamed at REALTIME, and a
    // test that emits a 0.5s utterance 0ms after attach is not that.
    expect(audio.epochMs).toBeLessThanOrEqual(segment.receivedAtMs);
  });

  it('A5: carries the client’s declared mic metadata onto the segment, and uses it for `speaker` only when diarization gave none', async () => {
    const { service, stream, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    // ArcaAI's ASR agent has diarization OFF, so `speakerLabel`/`speakerId` are absent on every
    // frame and the client's own TASK-951 declaration is the only source of attribution.
    stream.emit(
      frame({ text: 'cough since monday', startTime: 0, endTime: 2, utteranceIndex: 0, metadata: { mic_id: 'mic_1', speaker_label: 'Doctor' } }),
    );
    // The SAME declaration, but this frame also carries a diarization result. The measurement of
    // the audio must win over an assertion about it.
    stream.emit(
      frame({
        text: 'no fever',
        startTime: 2.5,
        endTime: 3.25,
        utteranceIndex: 1,
        speakerLabel: 'Speaker 1',
        metadata: { mic_id: 'mic_2', speaker_label: 'Patient' },
      }),
    );
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const segments = captureOutput(cache).segments as Array<Record<string, unknown>>;
    expect(segments).toHaveLength(2);
    // The declaration rides along WHOLE and uninterpreted — HOPE never reshapes it, so an
    // integration reads `metadata.mic_id` here exactly as it wrote it.
    expect(segments[0].metadata).toEqual({ mic_id: 'mic_1', speaker_label: 'Doctor' });
    expect(segments[1].metadata).toEqual({ mic_id: 'mic_2', speaker_label: 'Patient' });
    expect(segments[0].speaker).toBe('Doctor');
    expect(segments[1].speaker).toBe('Speaker 1');
  });

  it('A5: a session that declared no metadata publishes segments with no metadata key at all', async () => {
    const { service, stream, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    stream.emit(frame({ text: 'cough since monday', startTime: 0, endTime: 2, utteranceIndex: 0 }));
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const [segment] = captureOutput(cache).segments as Array<Record<string, unknown>>;
    // Byte-identical to the pre-A5 wire for every client that does not use TASK-951 metadata —
    // an `undefined`-valued key would still change the published JSON shape.
    expect('metadata' in segment).toBe(false);
    expect('speaker' in segment).toBe(false);
  });

  it('an UNTIMED ingest contributes its words and no segment — never a fabricated `start: 0`', async () => {
    const { service, cache } = buildService();
    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();

    // The manual path: a caller with text and nothing else.
    service.ingestSegment(CID, { text: 'patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const output = captureOutput(cache);
    expect(output.transcript).toBe('patient reports cough');
    expect(output.segments).toEqual([]);
  });
});
