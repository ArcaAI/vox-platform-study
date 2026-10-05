/**
 * The run-frame NORMALISER (TASK-1039 R3): one SSE frame in, protocol-v2 events out.
 *
 * `useRun` (and the engine under it) never sees a frame shape. A gateway that has shipped protocol v2 sends v2 envelopes
 * (`{ seq, runId, type, ts, nodeId?, data }`) and they pass through untouched. For ONE release a
 * gateway that has not — or a run that started before the deploy — sends the legacy
 * async-contract envelopes (`workflow.run.progress`, `workflow.node.*`, `workflow.token.delta`,
 * `workflow.run.completed`), and those are mapped onto the v2 events they correspond to. The legacy
 * vocabulary is smaller, so the mapping is lossy in one direction only: events v2 has and legacy
 * never carried (debug events, `run.started`, non-text outputs) simply do not appear.
 *
 * Legacy frames carry no `seq`. The events this class synthesises number themselves from a local
 * counter so consumers can still rely on `seq` being increasing within one stream; that number is
 * NOT a resume cursor — a legacy stream resumes by echoing the frame's opaque `id`, which
 * the run stream client does without parsing it.
 *
 * Remove the legacy half with the release that retires protocol selection (OD-23).
 */

import type { SseFrame } from './sse';
import { type RunEventType, type RunEventV2, parseRunEvent, runErrorMessage } from './run-protocol';

/** What one frame turned into. */
export interface NormalisedFrame {
  /** Which wire shape the frame was. `null` when it was neither (skipped). */
  readonly protocol: 2 | 'legacy' | null;
  /** Zero or more v2 events — zero for a skipped frame, a status hint or an unmapped legacy type. */
  readonly events: RunEventV2[];
  /** A legacy snapshot frame's run status, which is state but not an event. */
  readonly statusHint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LEGACY_NODE_STATUS: Readonly<Record<string, 'COMPLETED' | 'DEGRADED' | 'SKIPPED'>> = Object.freeze({
  SUCCEEDED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
  DEGRADED: 'DEGRADED',
  SKIPPED: 'SKIPPED',
});

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Elapsed ms between two ISO timestamps, or `0` when either is absent or unparseable. */
function elapsedMs(startedAt: unknown, endedAt: unknown): number {
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/**
 * Stateful only in the synthetic-`seq` counter, so build ONE per connection (or per iteration) and
 * feed it that connection's frames in order.
 */
export class RunFrameNormaliser {
  private nextSeq = 1;

  constructor(private readonly runId: string) {}

  normalise(frame: Pick<SseFrame, 'data'> & Partial<SseFrame>): NormalisedFrame {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      // One malformed frame must not destroy a stream whose other frames are fine.
      return { protocol: null, events: [] };
    }
    if (!isRecord(parsed)) return { protocol: null, events: [] };

    if (typeof parsed.seq === 'number' && typeof parsed.type === 'string' && 'data' in parsed) {
      const event = parseRunEvent(parsed);
      return { protocol: 2, events: event === null ? [] : [event] };
    }
    if (typeof parsed.schemaVersion === 'number' && typeof parsed.type === 'string' && 'correlationId' in parsed) {
      return this.fromLegacy(parsed);
    }
    return { protocol: null, events: [] };
  }

  private make<T extends RunEventType>(type: T, ts: string, data: RunEventV2<T>['data'], nodeId?: string): RunEventV2 {
    return { seq: this.nextSeq++, runId: this.runId, type, ts, ...(nodeId === undefined ? {} : { nodeId }), data } as unknown as RunEventV2;
  }

  private fromLegacy(envelope: Record<string, unknown>): NormalisedFrame {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const ts = stringOr(envelope.occurredAt) ?? new Date(0).toISOString();
    const nodeId = stringOr(payload.nodeId);

    switch (envelope.type) {
      case 'workflow.run.progress': {
        const status = stringOr(payload.status);
        return { protocol: 'legacy', events: [], ...(status === undefined ? {} : { statusHint: status }) };
      }
      case 'workflow.node.started':
        if (nodeId === undefined) break;
        return { protocol: 'legacy', events: [this.make('node.started', ts, { kind: stringOr(payload.nodeType) ?? 'unknown' }, nodeId)] };
      case 'workflow.node.completed': {
        if (nodeId === undefined) break;
        const status = LEGACY_NODE_STATUS[String(payload.status)] ?? 'COMPLETED';
        return { protocol: 'legacy', events: [this.make('node.completed', ts, { status, durationMs: 0 }, nodeId)] };
      }
      case 'workflow.node.failed': {
        if (nodeId === undefined) break;
        const reason = stringOr(payload.reason);
        const code = reason !== undefined && CODE_PATTERN.test(reason) ? reason : 'INTERNAL_ERROR';
        return {
          protocol: 'legacy',
          events: [this.make('node.failed', ts, { durationMs: 0, error: { code, message: runErrorMessage(code), nodeId } }, nodeId)],
        };
      }
      case 'workflow.token.delta': {
        if (nodeId === undefined || typeof payload.text !== 'string') break;
        return { protocol: 'legacy', events: [this.make('output.text.delta', ts, { field: 'text', text: payload.text }, nodeId)] };
      }
      case 'workflow.run.completed':
        return { protocol: 'legacy', events: [this.legacyTerminal(ts, payload)] };
      default:
        // `workflow.loop.iteration`, `workflow.guardrail.verdict`: no v2 counterpart on the public plane.
        break;
    }
    return { protocol: 'legacy', events: [] };
  }

  /** `workflow.run.completed` is the legacy terminal for EVERY outcome; the payload `status` says which. */
  private legacyTerminal(ts: string, payload: Record<string, unknown>): RunEventV2 {
    const status = String(payload.status ?? '');
    const durationMs = elapsedMs(payload.startedAt, payload.endedAt);
    const result = isRecord(payload.result) && (payload.result.kind === 'inline' || payload.result.kind === 'ref') ? payload.result : undefined;

    if (status === 'CANCELLED' || status === 'CANCELED') {
      const reason = stringOr(payload.reason);
      return this.make('run.cancelled', ts, { status: 'CANCELED', durationMs, ...(reason === undefined ? {} : { reason }) });
    }
    if (status === 'FAILED' || status === 'TIMED_OUT') {
      const reason = stringOr(payload.reason);
      const code = reason !== undefined && CODE_PATTERN.test(reason) ? reason : status === 'TIMED_OUT' ? 'RUN_TIMED_OUT' : 'INTERNAL_ERROR';
      return this.make('run.failed', ts, { status, durationMs, error: { code, message: runErrorMessage(code) } });
    }
    return this.make('run.completed', ts, {
      status: 'COMPLETED',
      durationMs,
      tokens: { in: 0, out: 0 },
      ...(status === 'DEGRADED' ? { degraded: true } : {}),
      ...(result === undefined ? {} : { result: result as never }),
    });
  }
}
