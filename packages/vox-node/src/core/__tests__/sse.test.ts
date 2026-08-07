import { describe, expect, it } from 'vitest';

import { parseSseStream } from '../sse';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseSseStream — basic frames', () => {
  it('parses a single event: + data: frame', async () => {
    const stream = streamFromChunks(['event: delta\ndata: {"text":"hi"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('parses multiple frames delivered in one chunk', async () => {
    const stream = streamFromChunks(['event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'delta', data: '{"text":"b"}' },
    ]);
  });

  it('defaults event to "message" when no event: line is present (SSE spec default)', async () => {
    const stream = streamFromChunks(['data: {"text":"hi"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'message', data: '{"text":"hi"}' }]);
  });

  it('carries the id: field when present', async () => {
    const stream = streamFromChunks(['id: 42\nevent: result\ndata: {"ok":true}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'result', data: '{"ok":true}', id: '42' }]);
  });
});

describe('parseSseStream — multi-line data', () => {
  it('joins multiple data: lines with \\n', async () => {
    const stream = streamFromChunks(['event: message\ndata: line1\ndata: line2\ndata: line3\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'message', data: 'line1\nline2\nline3' }]);
  });
});

describe('parseSseStream — :comment keepalive frames', () => {
  it('does not surface :keepalive as an event', async () => {
    const stream = streamFromChunks([':keepalive\n\nevent: delta\ndata: {"text":"hi"}\n\n:keepalive\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('yields nothing for a stream of only keepalives', async () => {
    const stream = streamFromChunks([':keepalive\n\n:keepalive\n\n:keepalive\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([]);
  });
});

describe('parseSseStream — frames split across chunk boundaries', () => {
  it('reassembles a frame whose data: line is split mid-value', async () => {
    const stream = streamFromChunks(['event: delta\ndata: {"te', 'xt":"hi"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('reassembles a frame split exactly at the blank-line delimiter', async () => {
    const stream = streamFromChunks(['event: delta\ndata: {"text":"hi"}\n', '\nevent: delta\ndata: {"text":"bye"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'delta', data: '{"text":"bye"}' },
    ]);
  });

  it('reassembles a frame split one character at a time', async () => {
    const raw = 'event: delta\ndata: {"text":"hi"}\n\n';
    const stream = streamFromChunks(raw.split(''));
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });
});

describe('parseSseStream — line endings', () => {
  it('treats \\r\\n the same as \\n', async () => {
    const stream = streamFromChunks(['event: delta\r\ndata: {"text":"hi"}\r\n\r\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('does not create a spurious blank frame when \\r\\n is split exactly at the \\r|\\n boundary', async () => {
    // chunk 1 ends with a lone \r; chunk 2 starts with the paired \n — a naive
    // per-chunk normalizer would turn the dangling \r into its own \n before
    // the real \n arrives, producing an extra blank line (a phantom frame).
    const stream = streamFromChunks(['event: delta\r\ndata: {"text":"hi"}\r', '\n\r\nevent: delta\r\ndata: {"text":"bye"}\r\n\r\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'delta', data: '{"text":"bye"}' },
    ]);
  });

  it('treats a lone \\r as a line ending too', async () => {
    const stream = streamFromChunks(['event: delta\rdata: {"text":"hi"}\r\r']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });
});

describe('parseSseStream — stream end handling', () => {
  it('ends cleanly (no throw) when the stream closes without a terminal frame', async () => {
    const stream = streamFromChunks(['event: delta\ndata: {"text":"partial"}\n\n']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'delta', data: '{"text":"partial"}' }]);
  });

  it('flushes a final well-formed frame that arrives without a trailing blank line', async () => {
    const stream = streamFromChunks(['event: result\ndata: {"ok":true}']);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([{ event: 'result', data: '{"ok":true}' }]);
  });

  it('yields nothing for an entirely empty stream', async () => {
    const stream = streamFromChunks([]);
    const frames = await collect(parseSseStream(stream));
    expect(frames).toEqual([]);
  });
});

describe('parseSseStream — abort mid-stream', () => {
  function neverEndingStream(firstChunk: string): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk));
        // Deliberately never close — simulates a long-lived SSE connection.
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, wasCancelled: () => cancelled };
  }

  it('rejects the next() call and cancels/releases the reader on abort', async () => {
    const { stream, wasCancelled } = neverEndingStream('event: delta\ndata: {"text":"hi"}\n\n');
    const controller = new AbortController();
    const iterator = parseSseStream(stream, { signal: controller.signal })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ event: 'delta', data: '{"text":"hi"}' });

    controller.abort();
    await expect(iterator.next()).rejects.toBeTruthy();

    expect(stream.locked).toBe(false);
    expect(wasCancelled()).toBe(true);
  });

  it('throws immediately for a signal that is already aborted', async () => {
    const { stream } = neverEndingStream('event: delta\ndata: {"text":"hi"}\n\n');
    const controller = new AbortController();
    controller.abort();

    const iterator = parseSseStream(stream, { signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeTruthy();
  });
});
