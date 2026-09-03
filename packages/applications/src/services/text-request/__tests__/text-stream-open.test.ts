import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { readGenerationId } from '../text-stream-open';

/**
 * learning a generation's id without consuming it.
 *
 * The single-call contract puts the id in the first SSE frame's `data`, so a
 * caller whose real consumer is a browser reads that one frame and lets go. The
 * behaviour under test is deliberately narrow, because the interesting property
 * is what it does NOT do: it never waits for content, and letting go of the
 * socket is never a cancel.
 */

function makeStream() {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  return stream;
}

const frame = (event: string, data: unknown, id: string) => `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;

describe('readGenerationId', () => {
  it('reads the id from the first frame and destroys the stream', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    stream.emit('data', Buffer.from(frame('meta', { generation_id: 'gen-9' }, 'gen-9:0')));

    await expect(pending).resolves.toBe('gen-9');
    // Dropping OUR subscription — not a cancel. The producer runs on.
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('resolves without waiting for any content frame', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    stream.emit('data', Buffer.from(frame('meta', { generation_id: 'gen-9' }, 'gen-9:0')));
    await expect(pending).resolves.toBe('gen-9');

    // The very point of the meta frame: the client can persist the id BEFORE a
    // single token exists, so it can reconnect to a generation it has not seen.
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('reassembles an id split across two socket chunks', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    const whole = frame('meta', { generation_id: 'gen-9' }, 'gen-9:0');
    stream.emit('data', Buffer.from(whole.slice(0, 20)));
    stream.emit('data', Buffer.from(whole.slice(20)));

    await expect(pending).resolves.toBe('gen-9');
  });

  it('skips heartbeat comments and any frame that does not name a generation', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    stream.emit('data', Buffer.from(':keepalive\n\n'));
    stream.emit('data', Buffer.from('event: ping\ndata: not-json\n\n'));
    stream.emit('data', Buffer.from(frame('meta', { generation_id: 'gen-9' }, 'gen-9:0')));

    await expect(pending).resolves.toBe('gen-9');
  });

  it('rejects when the stream ends without naming a generation', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    stream.emit('end');

    // A generation whose id we never learned is one nobody can resume. Failing
    // is the only honest outcome — an empty id would ack a stream that can
    // never be reopened.
    await expect(pending).rejects.toThrow(/before sending a generation id/);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects on a transport error and still tears the socket down', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    stream.emit('error', new Error('socket hang up'));

    await expect(pending).rejects.toThrow('socket hang up');
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects once the preamble grows past the frame bound with no id', async () => {
    const stream = makeStream();
    const pending = readGenerationId(stream as unknown as Readable);

    // No frame boundary at all — a malformed upstream must not be buffered
    // without limit while we wait for a frame that will never close.
    stream.emit('data', Buffer.from('x'.repeat(64_001)));

    await expect(pending).rejects.toThrow(/frame-size bound/);
  });

  it('rejects when no frame arrives within the timeout', async () => {
    const stream = makeStream();

    await expect(readGenerationId(stream as unknown as Readable, 5)).rejects.toThrow(/stream-open timeout/);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });
});
