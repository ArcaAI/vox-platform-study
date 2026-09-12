// TASK-959 T1-merge: DELETE this file once `LlmStreamUsageCollector` exposes the terminal usage
// block it already parses. Every use is marked with the same tag.
//
// ============================================================================
// WHY IT EXISTS, AND WHY IT IS NOT A SECOND SSE PARSER
// ============================================================================
// The shared collector (`usageLedger/llm-stream-usage.ts`, lane T1's file this wave) reads the
// terminal frame, hands the tokens to `buildLlmUsageInput` and keeps the parsed block PRIVATE.
// TASK-959 needs four more scalars off that same block — `total_ms`, `engine_ms`,
// `request_bytes`, `response_bytes` — and this lane may not edit that file.
//
// So this does NOT re-implement the collector. It runs no incremental frame state machine, has
// no frame-boundary scan, no carry-over semantics and no token handling: it keeps a bounded
// window of the END of the stream and, ONCE at teardown — when the stream is complete and there
// is no partial-frame question left — reads the last `data:` line that mentions a usage block.
// The collector remains the only thing that decides what is BILLED; the worst this can do is
// answer `null`, which costs a compute row and never a token.
//
// The window holds generated clinical text, so it is never logged and never leaves this object.

/**
 * Bytes of the stream's END retained. The terminal frame is the last frame `apps/text` writes
 * (`streaming.py` holds the provider's `done` back so it can carry the usage block), and the
 * block itself — counters plus the provider's raw usage object — is a few hundred bytes. 32 KB
 * is generous for it and bounded regardless of how long the generation ran.
 */
const TAIL_WINDOW_BYTES = 32_000;

export class TerminalUsageTail {
  private tail = '';

  /** Feed one forwarded chunk. NEVER throws: this runs inside a stream `data` handler. */
  observe(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.tail = (this.tail + text).slice(-TAIL_WINDOW_BYTES);
  }

  /**
   * The terminal frame's usage block, read once the stream is over.
   *
   * `null` three honest ways: no frame carried a usage block, the window clipped the frame it
   * was in, or the payload was not the shape `apps/text` documents. All three mean "no compute
   * row", which is the correctable direction.
   */
  usageBlock(): Record<string, unknown> | null {
    // `apps/text` frames with CRLF (`sse_starlette`); normalising once, here, is enough because
    // nothing incremental depends on it.
    const lines = this.tail.replace(/\r\n/g, '\n').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.startsWith('data:') || !line.includes('"usage"')) continue;
      try {
        const payload = JSON.parse(line.slice('data:'.length).trim()) as { data?: { usage?: unknown }; usage?: unknown };
        // `apps/text` nests it under `data`; the flat spelling is accepted for the same reason
        // the collector accepts it — a frame-shape change degrades to "not metered".
        const usage = payload?.data?.usage ?? payload?.usage;
        if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) return usage as Record<string, unknown>;
      } catch {
        // A clipped or non-JSON line. Not logged: it is generated clinical text.
      }
    }
    return null;
  }
}
