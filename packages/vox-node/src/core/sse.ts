/**
 * Server-Sent Events parser over a raw `ReadableStream<Uint8Array>`
 * (`response.body`), NOT the browser `EventSource` API.
 *
 * `EventSource` can't set request headers, which is the entire reason a
 * server-side, header-authenticated SDK needs its own parser: HOPE's
 * streaming routes are authenticated with `X-API-Key` (see
 * `core/transport.ts`), a header `EventSource` has no way to attach. This
 * module implements just enough of the SSE wire format (WHATWG "Server-Sent
 * Events" §9.2) to decode HOPE's frames: `event:`/`data:`/`id:` fields,
 * multi-line `data:`, `:`-prefixed comment/keepalive frames, and both
 * `\n`/`\r\n`/`\r` line endings.
*/

/** One decoded SSE frame. `event` defaults to `"message"` per spec when the frame carries no `event:` field. */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Options for {@link parseSseStream}. */
export interface ParseSseStreamOptions {
  /** Stops iteration and cancels/releases the underlying reader when aborted. */
  signal?: AbortSignal;
}

/**
 * Parse one raw frame body (the text between two blank lines, with line
 * endings already normalized to `\n`) into an {@link SseFrame}. Returns
 * `null` when the frame carries no `data:` field — a comment-only frame
 * (e.g. `:keepalive`) or an id-only frame never dispatches an event, per the
 * SSE spec's "if the data buffer is empty, set the data buffer and the
 * event type buffer to the empty string and return" step.
 */
function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // blank (shouldn't occur inside a frame) / comment
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1); // exactly one leading space is stripped, per spec

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      default:
        // Other fields (e.g. `retry:`) are not used by any HOPE SSE route — ignored.
        break;
    }
  }

  if (dataLines.length === 0) return null;
  return { event: event ?? 'message', data: dataLines.join('\n'), id };
}

/** Result of normalizing one decoded text chunk against a carried-over dangling `\r`. See {@link normalizeChunk}. */
interface NormalizedChunk {
  normalized: string;
  carryCR: boolean;
}

/**
 * Normalize `\r\n` and lone `\r` to `\n`, WITHOUT breaking a `\r\n` pair that
 * is split across two chunks. If `text` ends with a `\r` we can't yet tell
 * whether it's a lone CR (→ should become `\n` immediately) or the first
 * half of a `\r\n` pair (→ the `\n` is still in flight) — so that trailing
 * `\r` is held back (`carryCR: true`) and re-prepended to the START of the
 * next chunk before normalizing it. A naive per-chunk `replace(/\r/g, '\n')`
 * would convert a boundary-split `\r\n` into `\n\n` — a phantom blank line —
 * one chunk too early.
 */
function normalizeChunk(carryCR: boolean, text: string): NormalizedChunk {
  const combined = carryCR ? '\r' + text : text;
  const endsWithCR = combined.endsWith('\r');
  const body = endsWithCR ? combined.slice(0, -1) : combined;
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { normalized, carryCR: endsWithCR };
}

/**
 * Parse an SSE byte stream into an `AsyncIterable<SseFrame>`. Frames whose
 * only content is a comment (e.g. the gateway's `:keepalive` heartbeat) are
 * never yielded. If the stream closes with a well-formed but un-terminated
 * final frame (no trailing blank line), that frame is still flushed and
 * yielded before the iterable completes; if the stream simply ends (with or
 * without a domain-level terminal frame), the iterable completes cleanly —
 * callers distinguish "the summary finished" from "the connection closed"
 * by the frame CONTENT (e.g. `event: result`), not by iterable completion.
 *
 * Reading is done manually via `body.getReader()` (rather than piping
 * through a `TransformStream`) so an aborted `signal` can race a pending
 * `read()` and guarantee the reader is cancelled and released in a `finally`
 * — see the "abort mid-stream releases the reader" behavior below.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>, options: ParseSseStreamOptions = {}): AsyncGenerator<SseFrame, void, void> {
  const { signal } = options;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let carryCR = false;

  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;

  try {
    for (;;) {
      const { done, value } = abortPromise ? await Promise.race([reader.read(), abortPromise]) : await reader.read();

      if (done) {
        if (carryCR) buffer += '\n';
        const trailing = buffer.trim().length > 0 ? parseFrame(buffer) : null;
        if (trailing) yield trailing;
        return;
      }

      const decoded = decoder.decode(value, { stream: true });
      const { normalized, carryCR: nextCarry } = normalizeChunk(carryCR, decoded);
      carryCR = nextCarry;
      buffer += normalized;

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      // Already closed/cancelled — nothing to do.
    }
    reader.releaseLock();
  }
}
