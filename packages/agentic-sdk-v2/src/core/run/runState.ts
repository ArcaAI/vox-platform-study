/**
 * The pure state a `useRun` shows (TASK-1039): fold protocol-v2 events into text, status, the
 * event list and the error. No React, no I/O — `useRun` owns both.
 */

import type { PublicRunEventType, RunEventV2, RunStatus } from './run-protocol';
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
        case 'output.text.delta':
          return event.data.field === TEXT_FIELD ? (withText(next, appendDelta(next.nodeText, event.nodeId ?? '', event.data.text)) as RunState<TOutput>) : next;
        case 'node.started':
          // A retried node starts its output over: the earlier partial text belongs to a failed attempt.
          return (event.data.attempt ?? 1) > 1 && event.nodeId !== undefined
            ? (withText(
                next,
                next.nodeText.filter(([id]) => id !== event.nodeId),
              ) as RunState<TOutput>)
            : next;
        case 'run.completed':
          return { ...next, status: 'COMPLETED' };
        case 'run.cancelled':
          return { ...next, status: 'CANCELED' };
        case 'run.failed': {
          const { status, error } = event.data;
          return { ...next, status, error: new RunFailedError({ runId: event.runId, status, code: error.code, message: error.message }) };
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
