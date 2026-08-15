'use client';

/**
 * SMR task SSE, consumed through the house ticket flow: `useEventStream` mints
 * a single-use ticket per connect and the browser connects DIRECTLY to the
 * gateway (JWTs never appear in a URL, streams never traverse the BFF proxy).
 *
 * Replay contract: the SMR endpoint reads `last_event_id` from the QUERY STRING
 * only and nothing forwards it, so EVERY (re)connect replays the task's chunk
 * log from 0-0. The hook therefore keys its accumulator by connection and
 * disables the shared hook's automatic reconnect (`maxRetries: 0`) — an
 * auto-reconnect would silently re-append the whole replay. Recovery is the
 * explicit `reopen()`, which starts a fresh connection AND a fresh accumulation.
 *
 * `error` events are ambiguous by SSE design: upstream failure FRAMES carry a
 * JSON `data` string ({ type: 'error', data: { error } }); transport drops
 * dispatch a plain Event with no data (surfaced by the shared hook's own
 * status/error). `failed` vs `error` status keeps the two apart for the UI.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEventStream } from './use-event-stream';

/** SMR token accounting carried by the terminal `usage` frame. */
export interface SmrTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** SSE frame on GET text/tasks/:taskId/stream (SMR StreamChunk; named events). */
export interface SmrStreamFrame {
  type: 'chunk' | 'reasoning' | 'meta' | 'done' | 'error' | 'usage';
  content?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Gateway SSE path (relative to /api/v1) for a task stream. Shared by every
 * consumer of an SMR generation job (LLM playground, prompt-template test).
 */
export function taskStreamPath(taskId: string): string {
  return `text/tasks/${encodeURIComponent(taskId)}/stream`;
}

/** Ticket scope — must match the route's `@StreamScope({ namespace: 'smr_task' })`. */
export function taskStreamScope(taskId: string): string {
  return `smr_task:${taskId}`;
}

export type TaskStreamStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'failed' | 'error' | 'closed';

export interface TaskStreamState {
  status: TaskStreamStatus;
  /** Accumulated chunk text (a reconnect replay starts a fresh accumulation). */
  content: string;
  /** Accumulated reasoning/thinking text (same replay-reset rule as content). */
  reasoning: string;
  chunkCount: number;
  usage: SmrTokenUsage | null;
  finishReason: string | null;
  error: string | null;
  /** Manual reattach after a transport drop (native auto-retry is disabled). */
  reopen: () => void;
  /** Local stop (the cancel affordance); keeps the accumulated content. */
  close: () => void;
}

interface StreamFields {
  content: string;
  reasoning: string;
  chunkCount: number;
  usage: SmrTokenUsage | null;
  finishReason: string | null;
  error: string | null;
}

const EMPTY_FIELDS: StreamFields = { content: '', reasoning: '', chunkCount: 0, usage: null, finishReason: null, error: null };

/** Event-driven slice; `key` ties it to one connection so stale data is ignored. */
interface StreamEventState extends StreamFields {
  key: string | null;
  status: Exclude<TaskStreamStatus, 'idle' | 'connecting'> | null;
}

const TEXT_EVENTS = ['chunk', 'reasoning', 'usage', 'done', 'error'] as const;

/** Statuses that end the stream — these outrank the live transport status. */
const TERMINAL_STATUSES = new Set<TaskStreamStatus>(['done', 'failed', 'closed']);

function parseFrame(data: string): SmrStreamFrame | null {
  try {
    return JSON.parse(data) as SmrStreamFrame;
  } catch {
    return null;
  }
}

export function useTaskStream(taskId: string | null): TaskStreamState {
  const [generation, setGeneration] = useState(0);
  const [eventState, setEventState] = useState<StreamEventState>({ key: null, status: null, ...EMPTY_FIELDS });

  // Each reopen() bumps the generation, so the key changes and the previous
  // connection's accumulation is discarded rather than replayed onto.
  const connectionKey = taskId ? `${taskId}#${generation}` : null;

  const path = taskId ? taskStreamPath(taskId) : null;
  const scope = taskId ? taskStreamScope(taskId) : null;

  const onEvent = useCallback(
    (type: string, data: string) => {
      const key = connectionKey;
      if (!key) return;
      const frame = parseFrame(data);

      if (type === 'error') {
        // A parseable data string marks an upstream failure FRAME; a bare
        // transport Event is handled by useEventStream's own status.
        if (!frame) return;
        const message = typeof frame.data?.error === 'string' ? frame.data.error : 'Generation failed';
        setEventState((previous) =>
          previous.key === key ? { ...previous, status: 'failed', error: message } : { key, ...EMPTY_FIELDS, status: 'failed', error: message },
        );
        return;
      }

      if (!frame) return;

      setEventState((previous) => {
        const base = previous.key === key ? previous : { key, status: 'streaming' as const, ...EMPTY_FIELDS };
        switch (type) {
          case 'chunk':
            return { ...base, status: base.status ?? 'streaming', content: base.content + (frame.content ?? ''), chunkCount: base.chunkCount + 1 };
          case 'reasoning':
            return { ...base, status: base.status ?? 'streaming', reasoning: base.reasoning + (frame.content ?? '') };
          case 'usage':
            return frame.data ? { ...base, usage: frame.data as unknown as SmrTokenUsage } : base;
          case 'done': {
            const reason = frame.data?.finish_reason;
            return { ...base, status: 'done', finishReason: typeof reason === 'string' ? reason : base.finishReason };
          }
          default:
            return base;
        }
      });
    },
    [connectionKey],
  );

  const stream = useEventStream({
    path,
    scope,
    eventNames: TEXT_EVENTS,
    onEvent,
    // Replay-from-0-0 makes silent reconnects unsafe; recovery is reopen().
    maxRetries: 0,
    enabled: !!taskId,
  });

  // Stale event data (older connection) is ignored via the key mismatch.
  const current = eventState.key === connectionKey ? eventState : null;

  // A terminal frame ends the stream — the SMR generator has returned, so the
  // source is closed from an effect (never during render).
  const terminal = current?.status === 'done' || current?.status === 'failed';
  const closeStream = stream.close;
  useEffect(() => {
    if (terminal) closeStream();
  }, [terminal, closeStream]);

  const reopen = useCallback(() => {
    setGeneration((current) => current + 1);
    stream.reopen();
  }, [stream]);

  const close = useCallback(() => {
    stream.close();
    setEventState((previous) =>
      previous.key === connectionKey ? { ...previous, status: 'closed' } : { key: connectionKey, status: 'closed', ...EMPTY_FIELDS },
    );
  }, [connectionKey, stream]);

  const status: TaskStreamStatus = useMemo(() => {
    if (!connectionKey) return 'idle';
    // Only a TERMINAL event outranks the transport status — a mid-stream
    // 'streaming' must not mask a subsequent connection drop.
    if (current?.status && TERMINAL_STATUSES.has(current.status)) return current.status;
    switch (stream.status) {
      case 'open':
        return 'streaming';
      case 'error':
        return 'error';
      case 'closed':
        return 'closed';
      default:
        return 'connecting';
    }
  }, [connectionKey, current?.status, stream.status]);

  const fields = current ?? EMPTY_FIELDS;

  return {
    status,
    content: fields.content,
    reasoning: fields.reasoning,
    chunkCount: fields.chunkCount,
    usage: fields.usage,
    finishReason: fields.finishReason,
    // A transport failure has no frame — surface the shared hook's message.
    error: fields.error ?? (stream.status === 'error' ? (stream.error ?? 'Stream connection lost') : null),
    reopen,
    close,
  };
}
