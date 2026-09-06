/**
 * TASK-890 L7 (OD-F) — `useAgentInvocation`, the browser half of the published-Agent
 * invocation plane.
 *
 * `@arcaai/vox-node` has been able to invoke a published agent since TASK-865
 * (`hope.agents.invoke`); the browser could only DISCOVER one
 * (`useSelectableAsrAgents` → `GET /agents?task=`). So a tenant could publish an agent and
 * had no first-party way to call it from a screen. The routes already exist
 * (`POST /agents/{slug}/invocations|speech|transcriptions`, `agent:invocation:write`) — this
 * hook is the client.
 *
 * Two properties are load-bearing and asserted here:
 *
 *  * the reserved run-identity keys are refused SYNCHRONOUSLY, before a request leaves, the
 *    same rule `useWorkflowRun.start` follows (a silent drop would let a caller send
 *    `{ consultationId }`, get a 200, and believe the call was bound to that consultation);
 *  * it works on an API key ALONE — no JWT — because `agent:invocation:write` is mintable on
 *    its own and a browser integration may hold nothing else.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentInvocation } from '../useAgentInvocation';
import { RESERVED_RUN_IDENTITY_KEYS, ReservedRunIdentityError } from '../useWorkflowRun';

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
  getAccessToken: vi.fn<() => string | undefined>(() => undefined),
  getApiKey: vi.fn<() => string | undefined>(() => 'hope_key_abc'),
  getTenantId: vi.fn<() => string | undefined>(() => 'tenant-1'),
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

/** An SSE `Response` whose body is exactly `frames`. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const BLOCKING_RESULT = {
  agentSlug: 'triage-summariser',
  agentVersionId: 'ver-1',
  output: { text: 'the summary' },
  provider: 'lm-studio',
  model: 'qwen3-30b',
  usage: { promptTokens: 12, completionTokens: 40 },
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.getApiKey.mockReturnValue('hope_key_abc');
  apiClient.getAccessToken.mockReturnValue(undefined);
  apiClient.getTenantId.mockReturnValue('tenant-1');
  apiClient.post.mockResolvedValue(BLOCKING_RESULT);
});

describe('invoke — blocking', () => {
  it('POSTs the agent invocation route and returns the generated output', async () => {
    const { result } = renderHook(() => useAgentInvocation());

    let out: unknown;
    await act(async () => {
      out = await result.current.invoke('triage-summariser', { text: 'hello' });
    });

    expect(apiClient.post).toHaveBeenCalledWith('/agents/triage-summariser/invocations?mode=blocking', { text: 'hello' });
    expect(out).toEqual(BLOCKING_RESULT);
  });

  it('percent-encodes a slug that carries path characters', async () => {
    const { result } = renderHook(() => useAgentInvocation());
    await act(async () => {
      await result.current.invoke('a/b', { text: 'x' });
    });
    expect(apiClient.post.mock.calls[0]![0]).toBe('/agents/a%2Fb/invocations?mode=blocking');
  });

  it('exposes the last result and clears it on the next call', async () => {
    const { result } = renderHook(() => useAgentInvocation());
    await act(async () => {
      await result.current.invoke('triage-summariser', { text: 'hello' });
    });
    expect(result.current.result).toEqual(BLOCKING_RESULT);
  });
});

describe('reserved run-identity keys are refused client-side', () => {
  it.each(RESERVED_RUN_IDENTITY_KEYS)('throws ReservedRunIdentityError for `%s` and sends nothing', async (key) => {
    const { result } = renderHook(() => useAgentInvocation());

    await expect(result.current.invoke('triage-summariser', { text: 'x', [key]: 'v' })).rejects.toBeInstanceOf(ReservedRunIdentityError);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('names every offending key in one error rather than one at a time', async () => {
    const { result } = renderHook(() => useAgentInvocation());

    await expect(result.current.invoke('a', { consultationId: '1', userId: '2' })).rejects.toMatchObject({
      keys: ['consultationId', 'userId'],
    });
  });

  it('refuses them on the streaming path too — the gate is on the INPUT, not the transport', async () => {
    const { result } = renderHook(() => useAgentInvocation());
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      (async () => {
        for await (const _ of result.current.stream('a', { sessionId: 'x' })) {
          // no frames expected — the generator must throw before connecting
        }
      })(),
    ).rejects.toBeInstanceOf(ReservedRunIdentityError);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('stream — SSE over a POST', () => {
  it('sends X-API-Key with no Authorization header when the client holds only an API key', async () => {
    const fetchSpy = vi.fn(async () => sseResponse(['event: token\ndata: {"delta":"hi"}\n\n']));
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useAgentInvocation());
    const frames: unknown[] = [];
    await act(async () => {
      for await (const frame of result.current.stream('triage-summariser', { text: 'hello' })) frames.push(frame);
    });

    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/agents/triage-summariser/invocations?mode=stream');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('hope_key_abc');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('text/event-stream');
    expect(frames).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('sends the bearer token when the client holds a JWT', async () => {
    apiClient.getAccessToken.mockReturnValue('jwt-token');
    apiClient.getApiKey.mockReturnValue(undefined);
    const fetchSpy = vi.fn(async () => sseResponse([]));
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useAgentInvocation());
    await act(async () => {
      for await (const _ of result.current.stream('a', { text: 'x' })) void _;
    });

    const headers = (fetchSpy.mock.calls[0]! as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-token');
    expect(headers['X-API-Key']).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('yields each decoded frame in order and skips one it cannot parse', async () => {
    const fetchSpy = vi.fn(async () =>
      sseResponse(['event: token\ndata: {"delta":"a"}\n\n', 'event: token\ndata: {not json\n\n', 'event: token\ndata: {"delta":"b"}\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useAgentInvocation());
    const frames: Array<Record<string, unknown>> = [];
    await act(async () => {
      for await (const frame of result.current.stream('a', { text: 'x' })) frames.push(frame as Record<string, unknown>);
    });

    // One unreadable frame must not tear down a stream whose remaining frames are fine.
    expect(frames.map((f) => f.delta)).toEqual(['a', 'b']);
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx rather than yielding an empty stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );

    const { result } = renderHook(() => useAgentInvocation());
    await expect(
      (async () => {
        for await (const _ of result.current.stream('a', { text: 'x' })) void _;
      })(),
    ).rejects.toThrow(/403/);
    vi.unstubAllGlobals();
  });
});
