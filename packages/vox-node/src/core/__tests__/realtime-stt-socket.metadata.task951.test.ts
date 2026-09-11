/**
 * TASK-951 R2 (clarified 2026-09-11) — `RealtimeSttSocket.setMetadata`, the client half of
 * per-span stream metadata.
 *
 * The gateway does the arithmetic; this class's job is narrow and the two things it must get
 * right are both about WHERE a failure surfaces:
 *
 *  1. **The frame carries no timestamp.** The client cannot know how much of its audio has been
 *     forwarded, and a wall clock would not survive buffering or a resume — so the offset is
 *     the server's own count and the frame is `{type, metadata}` and nothing else. A field that
 *     looked like a timestamp would invite a caller to set it.
 *  2. **The size bound throws HERE.** A caller that exceeds it learns at the call site, with a
 *     `RangeError` it can catch, instead of on an asynchronous `METADATA_TOO_LARGE` error frame
 *     two utterances later — by which time the audio it meant to label has already been
 *     transcribed under the previous value.
 *
 * Hermetic: `globalThis.WebSocket` is stubbed with `FakeWebSocket`, the same lookup the shipped
 * code performs. No socket is ever opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_STT_METADATA_BYTES, RealtimeSttSocket } from '../realtime-stt-socket';
import type { SttTranscriptResult } from '../../types/stt';
import { FakeWebSocket } from './support/fake-websocket';

const SESSION = {
  sessionId: 'sess-1',
  ticket: 'tkt-1',
  ticketExpiresAt: 4_000_000_000_000,
  wsUrl: '/ws/stt/stream',
};

function makeSocket(): RealtimeSttSocket {
  return new RealtimeSttSocket({
    baseUrl: 'http://localhost:8868',
    session: SESSION,
    now: () => 1_000,
    sleep: async () => undefined,
  });
}

/** Connect and hand back the socket plus the fake wire it opened. */
async function connected() {
  const socket = makeSocket();
  const connecting = socket.connect();
  const wire = await FakeWebSocket.opened();
  wire.emitOpen();
  await connecting;
  return { socket, wire };
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TASK-951 — RealtimeSttSocket#setMetadata', () => {
  it('sends `{type:"metadata", metadata}` as JSON — and NOTHING else', async () => {
    const { socket, wire } = await connected();

    socket.setMetadata({ micIds: ['mic-1'] });

    // `toEqual` on the whole frame, not a property probe: an extra field here would be a
    // timestamp a caller could set, which is exactly the design this contract rules out.
    expect(JSON.parse(String(wire.sent[0]))).toEqual({ type: 'metadata', metadata: { micIds: ['mic-1'] } });
    socket.close();
  });

  it('sends the object VERBATIM — nested, re-ordered and non-ASCII values all survive', async () => {
    const { socket, wire } = await connected();
    const value = { micIds: ['mic-2', 'mic-1'], room: 'Consultório', vendor: { nested: { deep: true } } };

    socket.setMetadata(value);

    expect(JSON.parse(String(wire.sent[0])).metadata).toEqual(value);
    socket.close();
  });

  it('can be called BEFORE the first audio frame, to label a session from its first sample', async () => {
    const { socket, wire } = await connected();

    socket.setMetadata({ micIds: ['mic-1'] });
    socket.sendPcm16(new Uint8Array([1, 2, 3, 4]));

    expect(JSON.parse(String(wire.sent[0])).type).toBe('metadata');
    expect(wire.sent[1]).toBeInstanceOf(Uint8Array);
    socket.close();
  });

  it('interleaves with audio — a change mid-stream is just another frame', async () => {
    const { socket, wire } = await connected();

    socket.setMetadata({ micIds: ['mic-1'] });
    socket.sendPcm16(new Uint8Array([1, 2]));
    socket.setMetadata({ micIds: ['mic-1', 'mic-2'] });
    socket.sendPcm16(new Uint8Array([3, 4]));

    expect(JSON.parse(String(wire.sent[0])).metadata).toEqual({ micIds: ['mic-1'] });
    expect(JSON.parse(String(wire.sent[2])).metadata).toEqual({ micIds: ['mic-1', 'mic-2'] });
    socket.close();
  });

  it('throws RangeError above the byte bound, and sends nothing', async () => {
    const { socket, wire } = await connected();

    expect(() => socket.setMetadata({ micIds: ['mic-1'], note: 'x'.repeat(MAX_STT_METADATA_BYTES) })).toThrow(RangeError);
    expect(wire.sent).toHaveLength(0);
    socket.close();
  });

  it('measures BYTES, not characters — a non-ASCII label is charged honestly', async () => {
    // `'é'.repeat(n)` is n characters but 2n bytes of JSON. A length check would admit an
    // object nearly twice the intended per-utterance and Redis cost, and the gateway (which
    // measures bytes) would then refuse what the SDK accepted.
    const { socket } = await connected();
    const justUnderInCharacters = { note: 'é'.repeat(MAX_STT_METADATA_BYTES - 20) };

    expect(JSON.stringify(justUnderInCharacters).length).toBeLessThan(MAX_STT_METADATA_BYTES);
    expect(() => socket.setMetadata(justUnderInCharacters)).toThrow(RangeError);
    socket.close();
  });

  it('accepts an object right at the bound', async () => {
    // Pins the boundary from the other side: the refusal must mean "too large", not "metadata
    // at all". `{"note":""}` is 11 bytes of envelope around the padding.
    const { socket, wire } = await connected();
    const atLimit = { note: 'x'.repeat(MAX_STT_METADATA_BYTES - 11) };

    expect(JSON.stringify(atLimit).length).toBe(MAX_STT_METADATA_BYTES);
    expect(() => socket.setMetadata(atLimit)).not.toThrow();
    expect(wire.sent).toHaveLength(1);
    socket.close();
  });

  it('throws when the socket is not connected, rather than dropping the declaration', async () => {
    // Silently discarding it would mislabel everything that followed once the caller DID
    // connect — the worst kind of failure, because transcripts keep arriving.
    const socket = makeSocket();

    expect(() => socket.setMetadata({ micIds: ['mic-1'] })).toThrow(/not connected/i);
  });
});

describe('TASK-951 — RealtimeSttSocket transcript metadata', () => {
  it('surfaces per-span `metadata` on the transcript event', async () => {
    const { socket, wire } = await connected();
    const seen: SttTranscriptResult[] = [];
    socket.on('transcript', (t) => seen.push(t));

    wire.emitMessage(
      JSON.stringify({
        type: 'transcript',
        text: 'good morning',
        startTime: 12,
        endTime: 15.1,
        isFinal: true,
        seq: 4,
        metadata: [
          { from: 12, to: 13.4, value: { micIds: ['mic-1'] } },
          { from: 13.4, to: 15.1, value: { micIds: ['mic-1', 'mic-2'] } },
        ],
      }),
    );

    expect(seen).toHaveLength(1);
    // Two spans: the client opened a second microphone mid-utterance, and the platform reports
    // that rather than stamping the whole segment with one of them.
    expect(seen[0]!.metadata).toEqual([
      { from: 12, to: 13.4, value: { micIds: ['mic-1'] } },
      { from: 13.4, to: 15.1, value: { micIds: ['mic-1', 'mic-2'] } },
    ]);
    // The spans are inside the segment's own window, so a consumer never needs the session clock.
    for (const span of seen[0]!.metadata!) {
      expect(span.from).toBeGreaterThanOrEqual(seen[0]!.startTime);
      expect(span.to).toBeLessThanOrEqual(seen[0]!.endTime);
    }
    socket.close();
  });

  it('leaves `metadata` undefined on a transcript that carries none', async () => {
    const { socket, wire } = await connected();
    const seen: SttTranscriptResult[] = [];
    socket.on('transcript', (t) => seen.push(t));

    wire.emitMessage(JSON.stringify({ type: 'transcript', text: 'hello', startTime: 0, endTime: 1, isFinal: true }));

    expect(seen[0]!.metadata).toBeUndefined();
    socket.close();
  });

  it('surfaces METADATA_SCHEMA_VIOLATION on the error channel, with its problems, and stays open', async () => {
    // A refused declaration is not a dead session: the audio keeps flowing and the previous
    // metadata stays in force. Nothing here may close the socket.
    const { socket, wire } = await connected();
    const errors: Array<{ code: string; problems?: string[] }> = [];
    socket.on('error', (e) => errors.push(e as { code: string; problems?: string[] }));

    wire.emitMessage(
      JSON.stringify({
        type: 'error',
        code: 'METADATA_SCHEMA_VIOLATION',
        message: 'nope',
        problems: ['/micIds: expected array'],
      }),
    );

    expect(errors[0]!.code).toBe('METADATA_SCHEMA_VIOLATION');
    expect(errors[0]!.problems).toEqual(['/micIds: expected array']);
    expect(wire.closed).toBeFalsy();
    socket.close();
  });
});
