import { buildLlmUsageInput, parseTextUsageDetail } from '../consultation/summary/text-usage';
import type { UsageEventBatchInput } from './dto';
import type { UsageTrigger } from './usage-attributes';
import { withUsageTrigger } from './usage-attributes';
import type { UsageOperation } from './vocabulary';

/**
 * The ONE SSE terminal-frame usage tee (TASK-890 §3.13).
 *
 * ============================================================================
 * WHY THIS IS SHARED RATHER THAN COPIED
 * ============================================================================
 * Four production paths relay an `apps/text` `/generate` stream to a caller and
 * must bill what crossed the wire: the playground proxy (which owned this logic
 * first, `text-proxy.controller.ts`), the agent invocation route, the
 * prompt-template test bench and the draft-agent test. The scanning is subtle
 * in exactly the ways that fail QUIETLY — a frame split across a chunk
 * boundary, a JSON.parse thrown inside a `data` handler that kills the relay, a
 * carry-over buffer that grows with the length of a generation, a teardown that
 * fires three times and bills three times. A second copy of it is a second
 * place for a dropped tail to become lost revenue that nobody notices.
 *
 * ============================================================================
 * THE THREE RULES IT ENFORCES
 * ============================================================================
 *  1. **Forward first, observe from a side copy.** The collector never touches
 *     the bytes going to the client; a caller writes the chunk out and hands
 *     the same buffer here.
 *  2. **Only complete `\n\n`-delimited frames are parsed, and only the ones
 *     that mention `"usage"`.** A token chunk is never JSON-parsed, and frame
 *     content is never logged — it is generated clinical text.
 *  3. **{@link take} answers once.** Teardown fires from `end`, `error` and the
 *     client's `close`; emission is idempotent at the ledger (the key is
 *     derived from the TEXT task id) but emitting once keeps the outbox from
 *     absorbing three copies of every stream.
 */

/** Beyond this, the carry-over is a malformed frame, not a pending one. */
const MAX_PENDING_BYTES = 64_000;

export interface LlmStreamUsageTakeParams {
  tenantId: string;
  /** `generate.stream` for every streaming path today; passed in so a new one cannot be guessed. */
  operation: UsageOperation;
  /** WHICH activity produced this stream (TASK-890 OD-E). Omitted only where no activity applies. */
  trigger?: UsageTrigger;
  /**
   * Override the terminal frame's own `interrupted` flag. Set it on the abort
   * paths: a stream the client hung up on may still have delivered a terminal
   * frame saying `interrupted: false`, and the row must record what happened to
   * the DELIVERY, not what TEXT believed when it wrote the frame.
   */
  interrupted?: boolean;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
}

export class LlmStreamUsageCollector {
  private tail = '';
  private terminalUsage: unknown = null;
  private taken = false;

  /** Bytes held back waiting for a frame boundary. Exposed for the bound test. */
  get pendingBytes(): number {
    return this.tail.length;
  }

  /** True once a terminal frame carrying a usage block has been seen. */
  get hasUsage(): boolean {
    return this.terminalUsage !== null;
  }

  /**
   * Feed one forwarded chunk. NEVER throws — this runs inside a stream `data`
   * handler, where a throw ends the relay the caller is being paid to deliver.
   */
  observe(chunk: Buffer | string): void {
    this.tail += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let boundary = this.tail.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = this.tail.slice(0, boundary);
      this.tail = this.tail.slice(boundary + 2);
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine && dataLine.includes('"usage"')) {
        try {
          const payload = JSON.parse(dataLine.slice('data:'.length).trim()) as { data?: { usage?: unknown }; usage?: unknown };
          // `apps/text` nests it under `data`; accept the flat spelling too so a
          // frame shape change degrades to "not metered", never to a crash.
          const usage = payload?.data?.usage ?? payload?.usage;
          if (usage) this.terminalUsage = usage;
        } catch {
          // A partially-delivered or non-JSON frame is not worth a log line (and
          // its body may be PHI) — the next frame may still carry usage.
        }
      }
      boundary = this.tail.indexOf('\n\n');
    }
    // Bound the carry-over: a frame this large is malformed, and holding it
    // would turn a metering nicety into a memory leak.
    if (this.tail.length > MAX_PENDING_BYTES) this.tail = '';
  }

  /**
   * Build the ledger batch for this stream, ONCE.
   *
   * `null` means "record nothing" and is the right answer three ways: no
   * terminal frame arrived, its block was a shape the normalizer refuses to
   * guess at, or every counter was zero. A request that consumed nothing gets
   * no row rather than a row saying nothing happened.
   */
  take(params: LlmStreamUsageTakeParams): UsageEventBatchInput | null {
    if (this.taken || this.terminalUsage === null) return null;
    this.taken = true;

    const usage = parseTextUsageDetail(this.terminalUsage);
    if (!usage) return null;

    const batch = buildLlmUsageInput({
      usage: params.interrupted === undefined ? usage : { ...usage, interrupted: params.interrupted },
      tenantId: params.tenantId,
      operation: params.operation,
      consultationId: params.consultationId ?? null,
      doctorId: params.doctorId ?? null,
      departmentId: params.departmentId ?? null,
    });
    return params.trigger ? withUsageTrigger(batch, params.trigger) : batch;
  }
}
