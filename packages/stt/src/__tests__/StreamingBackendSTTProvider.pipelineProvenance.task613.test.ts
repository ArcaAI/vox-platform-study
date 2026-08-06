/**
 * TASK-613 AC-1 — per-utterance pipeline provenance must survive the
 * `@arcaai/stt` transport hop.
 *
 * The backend stamps every transcript with the pipeline that produced THAT
 * utterance, and `@arcaai/vox`'s `SttWebSocketClient` surfaces it as
 * `pipelineId`. This provider is the bridge between that client and the SDK
 * store, so a drop here makes the whole chain pointless for every consumer
 * reading `audio.transcriptSegments`.
 */
import { describe, it, expect } from 'vitest';
import { StreamingBackendSTTProvider, type StreamingTranscriptPayload } from '../providers/StreamingBackendSTTProvider.js';

/**
 * The normalizer is pure with respect to these deps, so the stubs only need to
 * satisfy the constructor — no session or socket behaviour is exercised here.
 */
function makeProvider(): StreamingBackendSTTProvider {
  const sessionManager = {
    createSession: async () => ({ sessionId: 's-1', wsUrl: 'ws://localhost/ws', ticket: 't' }),
    closeSession: async () => undefined,
  };
  const wsClient = {
    connect: async () => undefined,
    disconnect: () => undefined,
    sendAudio: () => undefined,
    onTranscript: () => undefined,
    onWsError: () => undefined,
  };
  return new StreamingBackendSTTProvider({
    sessionManager,
    wsClient,
  } as unknown as ConstructorParameters<typeof StreamingBackendSTTProvider>[0]);
}

/** Reach the private normalizer without exporting it just for the test. */
function normalize(provider: StreamingBackendSTTProvider, payload: StreamingTranscriptPayload) {
  return (provider as unknown as { normalizeTranscript: (p: StreamingTranscriptPayload) => { pipelineId?: string } }).normalizeTranscript(payload);
}

function basePayload(overrides: Partial<StreamingTranscriptPayload> = {}): StreamingTranscriptPayload {
  return {
    type: 'transcript',
    text: 'the patient reports chest pain',
    startTime: 1.5,
    endTime: 3.25,
    isFinal: true,
    ...overrides,
  };
}

describe('StreamingBackendSTTProvider — pipeline provenance (TASK-613)', () => {
  it('forwards the per-utterance pipelineId to the transcription result', () => {
    const provider = makeProvider();
    const result = normalize(provider, basePayload({ pipelineId: 'pipe-primary-001' }));

    expect(result.pipelineId).toBe('pipe-primary-001');
  });

  it('carries the FALLBACK id after a mid-session switch, not the session id', () => {
    // The point of per-utterance provenance: consecutive utterances in one
    // session can legitimately name different engines.
    const provider = makeProvider();

    const before = normalize(provider, basePayload({ pipelineId: 'pipe-primary-001' }));
    const after = normalize(provider, basePayload({ pipelineId: 'pipe-fallback-002', text: 'and shortness of breath' }));

    expect(before.pipelineId).toBe('pipe-primary-001');
    expect(after.pipelineId).toBe('pipe-fallback-002');
  });

  it('degrades cleanly against an older backend that sends no pipelineId', () => {
    const provider = makeProvider();
    const result = normalize(provider, basePayload());

    expect('pipelineId' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('undefined');
  });
});
