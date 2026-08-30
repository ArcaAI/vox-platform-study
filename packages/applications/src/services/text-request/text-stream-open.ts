import type { Readable } from 'node:stream';

/**
 * Open a TEXT generation under the SINGLE-CALL streaming contract, and learn its
 * id without consuming the stream.
 *
 * TASK-818 §3C.3(1). `POST /api/v1/generate` with `stream:true` no longer returns
 * `202 {task_id, stream_url}` — it returns **200 + `text/event-stream`
 * immediately**, and the generation id arrives in the FIRST frame's `data`
 * (§3C.3(4)), not in a response body:
 *
 * ```
 * event: meta
 * data: {"generation_id":"…"}
 * id: {generation_id}:0
 * ```
 *
 * A caller that only needs the ID — because its real consumer is a browser that
 * will subscribe separately over `GET …/stream` with its own single-use ticket —
 * reads that one frame and then drops its subscription.
 *
 * **Dropping the subscription is not a cancel.** The producer is an `asyncio`
 * task owned by TEXT's generation hub, not by this HTTP response (§3C.3(1)), and
 * cancellation is an explicit `POST /generations/{gid}/cancel` (§3C.4). So the
 * generation runs on, every delta lands in the replay buffer, and the browser's
 * later subscription replays the whole prefix from seq 0 — no gap. Destroying
 * this socket is exactly the "drop ONLY our own upstream subscription" the
 * gateway relay is required to do on a browser disconnect (§3C.3(6)).
 */

/** How long to wait for the first frame before giving up on the open. */
const DEFAULT_META_TIMEOUT_MS = 30_000;

/** Guard against a malformed upstream that never emits a frame boundary. */
const MAX_PREAMBLE_BYTES = 64_000;

/**
 * Read `generation_id` off the first frame carrying one, then destroy the stream.
 *
 * Resolves with the id. Rejects — after destroying the stream — if the stream
 * ends, errors, or exceeds `timeoutMs` without one, because a generation whose
 * id we never learned is a generation nobody can resume.
 */
export function readGenerationId(stream: Readable, timeoutMs: number = DEFAULT_META_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (err: Error | null, id?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      // Drop OUR subscription only. The producer outlives it (§3C.3(1)).
      stream.destroy();
      if (err) reject(err);
      else resolve(id as string);
    };

    const timer = setTimeout(() => finish(new Error('TEXT did not send a generation id before the stream-open timeout')), timeoutMs);
    // A pending open must never hold the process open on its own.
    if (typeof timer.unref === 'function') timer.unref();

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const id = generationIdFromFrame(frame);
        if (id) {
          finish(null, id);
          return;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > MAX_PREAMBLE_BYTES) {
        finish(new Error('TEXT stream preamble exceeded the frame-size bound without a generation id'));
      }
    };

    const onEnd = (): void => finish(new Error('TEXT stream ended before sending a generation id'));
    const onError = (err: Error): void => finish(err);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * Pull `generation_id` out of one SSE frame's `data:` payload.
 *
 * Only the `data` line is trusted as the source, per §3C.3(4). The `id:` line
 * carries `{generation_id}:{seq}` too, but splitting that is guesswork where
 * `data` is a statement.
 */
function generationIdFromFrame(frame: string): string | null {
  const dataParts: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank / heartbeat comment
    if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
  }
  if (dataParts.length === 0) return null;
  try {
    const parsed = JSON.parse(dataParts.join('\n')) as { generation_id?: unknown };
    return typeof parsed.generation_id === 'string' && parsed.generation_id ? parsed.generation_id : null;
  } catch {
    // A non-JSON frame is not the meta frame; keep reading.
    return null;
  }
}
