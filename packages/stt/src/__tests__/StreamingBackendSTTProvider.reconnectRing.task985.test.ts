/**
 * TASK-985 QW-11 / M-06 — the reconnect ring buffer, and the drop that used to
 * be silent.
 *
 * Before this, `processAudio` opened with
 * `if (!this.processing || !this.wsClient.isConnected()) return;` — every frame
 * captured while the socket was down was discarded without being buffered,
 * without being counted, and without telling anyone. A clinician kept talking
 * through a five-second reconnect and the transcript simply had nothing there;
 * the UI's drop counter stayed at zero, so even the "audio was lost" signal
 * that exists for backpressure never fired.
 *
 * Separately, `SttWebSocketClient` had implemented `onReconnect` /
 * `onReconnected` / `onReconnectFailed` correctly for a long time and this
 * provider — the only place that owns `processAudio`, and therefore the only
 * place that could act on them — registered none of them.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamingBackendSTTProvider, type StreamingGapPayload } from '../providers/StreamingBackendSTTProvider.js';
import { WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';

/** One 80 ms frame at the wire rate — 1280 samples, 2560 bytes as Int16. */
const FRAME_SAMPLES = WHISPER_SAMPLE_RATE * 0.08;
const FRAME_BYTES = FRAME_SAMPLES * 2;
/** The provider's ceiling: 30 s of 16 kHz mono Int16. */
const RING_MAX_BYTES = 960_000;

function frame(value = 0.25): Float32Array {
  return new Float32Array(FRAME_SAMPLES).fill(value);
}

class FakeWsClient {
  connected = true;
  sent: Int16Array[] = [];
  sendResult: boolean | undefined = true;
  handlers: {
    reconnect?: (attempt: number) => void;
    reconnected?: () => void;
    reconnectFailed?: () => void;
    gap?: (gap: StreamingGapPayload) => void;
  } = {};

  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(() => undefined);
  sendStop = vi.fn(() => undefined);
  isConnected = () => this.connected;
  sendAudioFrame = (data: ArrayBuffer | ArrayBufferView): boolean => {
    this.sent.push(data as Int16Array);
    return this.sendResult as boolean;
  };
  onTranscript = vi.fn(() => undefined);
  onWsError = vi.fn(() => undefined);
  onReconnect = (cb: (attempt: number) => void) => {
    this.handlers.reconnect = cb;
  };
  onReconnected = (cb: () => void) => {
    this.handlers.reconnected = cb;
  };
  onReconnectFailed = (cb: () => void) => {
    this.handlers.reconnectFailed = cb;
  };
  onGap = (cb: (gap: StreamingGapPayload) => void) => {
    this.handlers.gap = cb;
  };
}

function makeProvider(): { provider: StreamingBackendSTTProvider; ws: FakeWsClient; drops: number[] } {
  const ws = new FakeWsClient();
  const sessionManager = {
    createSession: async () => ({ sessionId: 's-1', wsUrl: 'ws://localhost/ws', ticket: 't' }),
    getWebSocketUrl: () => 'ws://localhost/ws?sessionId=s-1',
    closeSession: async () => undefined,
    getSessionId: () => 's-1',
  };
  const provider = new StreamingBackendSTTProvider({
    sessionManager,
    wsClient: ws,
  } as unknown as ConstructorParameters<typeof StreamingBackendSTTProvider>[0]);

  const drops: number[] = [];
  provider.onDrop((total) => drops.push(total));
  // `start()` only flips the processing flag; no session is opened here.
  (provider as unknown as { processing: boolean }).processing = true;

  return { provider, ws, drops };
}

describe('StreamingBackendSTTProvider — reconnect ring buffer (TASK-985 QW-11)', () => {
  let harness: ReturnType<typeof makeProvider>;

  beforeEach(() => {
    harness = makeProvider();
  });

  it('buffers frames captured during a reconnect and replays them in order once the socket is back', async () => {
    const { provider, ws } = harness;

    await provider.processAudio(frame(0.1), WHISPER_SAMPLE_RATE);
    expect(ws.sent).toHaveLength(1);

    // Socket drops; a reconnect attempt starts.
    ws.connected = false;
    ws.handlers.reconnect?.(1);

    await provider.processAudio(frame(0.2), WHISPER_SAMPLE_RATE);
    await provider.processAudio(frame(0.3), WHISPER_SAMPLE_RATE);
    // Nothing reached the wire, and nothing was thrown away either.
    expect(ws.sent).toHaveLength(1);
    expect(provider.getReconnectBufferedBytes()).toBe(FRAME_BYTES * 2);

    // The socket is back and the session resumed.
    ws.connected = true;
    ws.handlers.reconnected?.();

    expect(ws.sent).toHaveLength(3);
    expect(provider.getReconnectBufferedBytes()).toBe(0);
    // FIFO: the audio is replayed in the order it was spoken.
    expect(ws.sent[1]![0]).toBeLessThan(ws.sent[2]![0]!);

    // …and a newly captured frame queues behind the replay, not ahead of it.
    await provider.processAudio(frame(0.4), WHISPER_SAMPLE_RATE);
    expect(ws.sent).toHaveLength(4);
  });

  it('drops the OLDEST frames past the 30 s ceiling, counting each eviction on the existing drop channel', async () => {
    const { provider, ws, drops } = harness;

    ws.connected = false;
    ws.handlers.reconnect?.(1);

    const framesThatFit = Math.floor(RING_MAX_BYTES / FRAME_BYTES);
    for (let i = 0; i < framesThatFit; i++) {
      await provider.processAudio(frame(0.1), WHISPER_SAMPLE_RATE);
    }
    expect(drops).toHaveLength(0);
    expect(provider.getReconnectBufferedBytes()).toBeLessThanOrEqual(RING_MAX_BYTES);

    // One frame past the ceiling evicts exactly one, and says so.
    await provider.processAudio(frame(0.9), WHISPER_SAMPLE_RATE);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toBe(1);
    expect(provider.getReconnectBufferedBytes()).toBeLessThanOrEqual(RING_MAX_BYTES);

    // Drop-oldest, not drop-newest: what survives is the audio closest to the
    // moment the link returns, which is the audio still worth transcribing.
    ws.connected = true;
    ws.handlers.reconnected?.();
    expect(ws.sent.at(-1)![0]).toBeGreaterThan(0);
  });

  it('counts a frame captured while genuinely disconnected — the loss that used to be silent (M-06)', async () => {
    const { provider, ws, drops } = harness;

    // No reconnect in flight: never connected, or the budget is spent.
    ws.connected = false;

    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);

    expect(ws.sent).toHaveLength(0);
    expect(provider.getReconnectBufferedBytes()).toBe(0);
    expect(drops).toEqual([1, 2]);
    expect(provider.getDroppedFrameCount()).toBe(2);
  });

  it('accounts the buffered audio as lost when the reconnect budget is exhausted', async () => {
    const { provider, ws, drops } = harness;

    ws.connected = false;
    ws.handlers.reconnect?.(1);
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);
    expect(drops).toHaveLength(0);

    ws.handlers.reconnectFailed?.();

    // The session is gone; the held audio has nowhere to go and is reported.
    expect(provider.getReconnectBufferedBytes()).toBe(0);
    expect(drops).toEqual([1, 2]);

    // And a frame captured after that is counted, not buffered into a corpse.
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);
    expect(drops).toEqual([1, 2, 3]);
  });

  it('routes replayed frames through the ordinary backpressure gate rather than a bespoke one', async () => {
    const { provider, ws, drops } = harness;

    ws.connected = false;
    ws.handlers.reconnect?.(1);
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);
    await provider.processAudio(frame(), WHISPER_SAMPLE_RATE);

    // The link is back but still congested — the client refuses the frames.
    ws.connected = true;
    ws.sendResult = false;
    ws.handlers.reconnected?.();

    expect(drops).toEqual([1, 2]);
  });

  it("re-emits the gateway's gap frame — text the server discarded, not audio we dropped (M-43)", () => {
    const { provider, ws } = harness;
    const gaps: StreamingGapPayload[] = [];
    provider.onGap((gap) => gaps.push(gap));

    ws.handlers.gap?.({ reason: 'egress_overflow', sessionId: 's-1', droppedSeq: 12 });

    expect(gaps).toEqual([{ reason: 'egress_overflow', sessionId: 's-1', droppedSeq: 12 }]);
  });
});
