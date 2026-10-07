/**
 * The pure state a `useRun` shows (TASK-1039): fold protocol-v2 events into text, status, the
 * event list and the error. No React, no I/O — `useRun` owns both.
 */

import type { PublicRunEventType, RunEventV2, RunGuardrailNotice, RunStatus } from './run-protocol';
import { RunFailedError } from './errors';

/** An event a business-plane run stream delivers. Narrow on `type` for the typed `data`. */
export type RunEvent = RunEventV2<PublicRunEventType>;

export interface RunState<TOutput = unknown> {
  runId: string | null;
  status: RunStatus | null;
  /** The `text` field of `output.text.delta`, grouped per node in order of first delta. */
  text: string;
  /** Per-node text, in order of first delta (an array: node ids are not guaranteed non-numeric keys). */
  nodeText: ReadonlyArray<readonly [string, string]>;
  events: RunEvent[];
  result: TOutput | null;
  error: Error | null;
  /** Every guardrail notice the run raised, one per `noticeId`, in first-seen order (TASK-1050). Show them; a warning never stops the run. */
  guardrailNotices: readonly RunGuardrailNotice[];
  /**
   * Set while the run waits at a guardrail hold (`run.paused`) — the run is NOT finished (`status` stays `RUNNING`).
   * Cleared when it moves on or ends. Resolve the hold through the consultation (`useConsultation().resumeHold`).
   */
  paused: { readonly noticeId: string; readonly nodeId: string; readonly reason: string } | null;
  /** The highest protocol-v2 `seq` reached — persist it and pass it back as `after` to resume. `0` on a legacy gateway. */
  lastSeq: number;
}

export const INITIAL_RUN_STATE: RunState = {
  runId: null,
  status: null,
  text: '',
  nodeText: [],
  events: [],
  result: null,
  error: null,
  guardrailNotices: [],
  paused: null,
  lastSeq: 0,
};

export type RunAction<TOutput = unknown> =
  | { type: 'started'; runId: string; status?: RunStatus }
  | { type: 'event'; event: RunEvent; reset: boolean; protocol: 2 | 'legacy'; maxEvents: number }
  | { type: 'result'; value: TOutput | null }
  | { type: 'error'; error: Error };

const TEXT_FIELD = 'text';

function withText(state: RunState, nodeText: ReadonlyArray<readonly [string, string]>): RunState {
  return { ...state, nodeText, text: nodeText.map(([, text]) => text).join('') };
}

function withNotices(state: RunState, incoming: readonly RunGuardrailNotice[]): readonly RunGuardrailNotice[] {
  let next: RunGuardrailNotice[] | undefined;
  for (const notice of incoming) {
    if (typeof notice?.noticeId !== 'string') continue;
    const list = next ?? [...state.guardrailNotices];
    const index = list.findIndex((existing) => existing.noticeId === notice.noticeId);
    if (index === -1) list.push(notice);
    else list[index] = notice;
    next = list;
  }
  return next ?? state.guardrailNotices;
}

function appendDelta(nodeText: RunState['nodeText'], node: string, delta: string): RunState['nodeText'] {
  const index = nodeText.findIndex(([id]) => id === node);
  if (index === -1) return [...nodeText, [node, delta]];
  return nodeText.map((entry, i) => (i === index ? ([node, entry[1] + delta] as const) : entry));
}

export function runReducer<TOutput>(state: RunState<TOutput>, action: RunAction<TOutput>): RunState<TOutput> {
  switch (action.type) {
    case 'started':
      return { ...(INITIAL_RUN_STATE as RunState<TOutput>), runId: action.runId, status: action.status ?? 'RUNNING' };
    case 'result':
      return { ...state, result: action.value };
    case 'error':
      return { ...state, error: action.error };
    case 'event': {
      const { event, reset, protocol, maxEvents } = action;
      const events = [...state.events, event];
      let next: RunState<TOutput> = {
        ...state,
        events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events,
        lastSeq: protocol === 2 ? (reset ? event.seq : Math.max(state.lastSeq, event.seq)) : state.lastSeq,
      };

      switch (event.type) {
        case 'run.started':
          return { ...next, status: 'RUNNING' };
        case 'guardrail.notice':
          return { ...next, guardrailNotices: withNotices(next, [event.data]) };
        case 'run.paused':
          // Not terminal: the run waits durably at the hold. `status` stays RUNNING.
          return { ...next, paused: { noticeId: event.data.noticeId, nodeId: event.data.nodeId, reason: event.data.reason } };
        case 'output.text.delta':
          return event.data.field === TEXT_FIELD
            ? (withText(next, appendDelta(next.nodeText, event.nodeId ?? '', event.data.text)) as RunState<TOutput>)
            : next;
        case 'node.started':
          if (next.paused !== null) next = { ...next, paused: null };
          // A retried node starts its output over: the earlier partial text belongs to a failed attempt.
          return (event.data.attempt ?? 1) > 1 && event.nodeId !== undefined
            ? (withText(
                next,
                next.nodeText.filter(([id]) => id !== event.nodeId),
              ) as RunState<TOutput>)
            : next;
        case 'run.completed':
          return { ...next, status: 'COMPLETED', paused: null, guardrailNotices: withNotices(next, event.data.guardrailNotices ?? []) };
        case 'run.cancelled':
          return { ...next, status: 'CANCELED', paused: null };
        case 'run.failed': {
          const { status, error } = event.data;
          return {
            ...next,
            status,
            paused: null,
            error: new RunFailedError({ runId: event.runId, status, code: error.code, message: error.message }),
          };
        }
        case 'run.resync': {
          // The server could not replay from our cursor: its snapshot replaces what we built.
          const { snapshot } = event.data;
          const nodeText: Array<readonly [string, string]> = [];
          for (const [node, fields] of Object.entries(snapshot.outputs)) {
            const text = fields[TEXT_FIELD];
            if (typeof text === 'string') nodeText.push([node, text]);
          }
          next = withText({ ...next, status: snapshot.status }, nodeText) as RunState<TOutput>;
          return next;
        }
        default:
          return next;
      }
    }
  }
}
