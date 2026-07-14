'use client';

/**
 * SMR task SSE, consumed same-origin through the BFF proxy with cookie auth
 * (see taskStreamProxyUrl for why tickets cannot work on this route).
 *
 * Replay contract: the SMR endpoint reads `last_event_id` from the QUERY
 * STRING only and the BFF proxy forwards neither it nor the Last-Event-ID
 * header, so EVERY (re)connect replays the task's chunk log from 0-0. The
 * hook therefore keys its accumulator by connection (a reconnect discards the
 * previous accumulation and `open` seeds a fresh one), closes the source on
 * transport errors instead of letting EventSource auto-retry (which would
 * re-append the replay), and exposes a manual `reopen()`.
 *
 * `error` events are ambiguous by SSE design: upstream failure FRAMES carry a
 * JSON `data` string ({ type: 'error', data: { error } }); transport drops
 * dispatch a plain Event with no data. `failed` vs `error` status keeps the
 * two apart for the UI.
 *
 * State is only ever written from EventSource callbacks and user actions
 * (never synchronously inside the effect); `idle`/`connecting` are derived.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { taskStreamProxyUrl } from './client';
import type { SmrStreamFrame, SmrTokenUsage } from './types';

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

function parseFrame(event: Event): SmrStreamFrame | null {
    const data = (event as MessageEvent).data as unknown;
    if (typeof data !== 'string') return null;
    try {
        return JSON.parse(data) as SmrStreamFrame;
    } catch {
        return null;
    }
}

export function useTaskStream(taskId: string | null): TaskStreamState {
    const [generation, setGeneration] = useState(0);
    const [eventState, setEventState] = useState<StreamEventState>({ key: null, status: null, ...EMPTY_FIELDS });
    const sourceRef = useRef<EventSource | null>(null);

    const connectionKey = taskId ? `${taskId}#${generation}` : null;

    useEffect(() => {
        if (!taskId || !connectionKey) return;
        const key = connectionKey;

        const source = new EventSource(taskStreamProxyUrl(taskId));
        sourceRef.current = source;

        source.onopen = () => {
            // The (re)connect replays from 0-0 — seed a fresh accumulation.
            setEventState({ key, status: 'streaming', ...EMPTY_FIELDS });
        };
        source.addEventListener('chunk', (event) => {
            const frame = parseFrame(event);
            if (!frame) return;
            setEventState((previous) =>
                previous.key === key
                    ? { ...previous, content: previous.content + (frame.content ?? ''), chunkCount: previous.chunkCount + 1 }
                    : previous,
            );
        });
        source.addEventListener('reasoning', (event) => {
            const frame = parseFrame(event);
            if (!frame) return;
            setEventState((previous) => (previous.key === key ? { ...previous, reasoning: previous.reasoning + (frame.content ?? '') } : previous));
        });
        source.addEventListener('usage', (event) => {
            const frame = parseFrame(event);
            if (!frame?.data) return;
            const usage = frame.data as unknown as SmrTokenUsage;
            setEventState((previous) => (previous.key === key ? { ...previous, usage } : previous));
        });
        source.addEventListener('done', (event) => {
            const reason = parseFrame(event)?.data?.finish_reason;
            const finishReason = typeof reason === 'string' ? reason : null;
            source.close();
            setEventState((previous) =>
                previous.key === key
                    ? { ...previous, status: 'done', finishReason: finishReason ?? previous.finishReason }
                    : { key, status: 'done', ...EMPTY_FIELDS, finishReason },
            );
        });
        source.addEventListener('error', (event) => {
            source.close();
            const frame = parseFrame(event);
            // A data string marks an upstream failure FRAME; a bare Event is a
            // transport drop (can fire before `open` on a refused connection).
            const failure: Pick<StreamEventState, 'status' | 'error'> = frame
                ? { status: 'failed', error: typeof frame.data?.error === 'string' ? frame.data.error : 'Generation failed' }
                : { status: 'error', error: 'Stream connection lost' };
            setEventState((previous) => (previous.key === key ? { ...previous, ...failure } : { key, ...EMPTY_FIELDS, ...failure }));
        });

        return () => {
            source.close();
            sourceRef.current = null;
        };
    }, [taskId, connectionKey]);

    const reopen = useCallback(() => setGeneration((current) => current + 1), []);
    const close = useCallback(() => {
        sourceRef.current?.close();
        setEventState((previous) =>
            previous.key === connectionKey ? { ...previous, status: 'closed' } : { key: connectionKey, status: 'closed', ...EMPTY_FIELDS },
        );
    }, [connectionKey]);

    // Stale event data (older connection) is ignored via the key mismatch.
    const current = eventState.key === connectionKey ? eventState : null;
    const status: TaskStreamStatus = !connectionKey ? 'idle' : (current?.status ?? 'connecting');
    const fields = current ?? EMPTY_FIELDS;

    return {
        status,
        content: fields.content,
        reasoning: fields.reasoning,
        chunkCount: fields.chunkCount,
        usage: fields.usage,
        finishReason: fields.finishReason,
        error: fields.error,
        reopen,
        close,
    };
}
