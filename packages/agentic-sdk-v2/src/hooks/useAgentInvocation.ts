/**
 * @arcaai/vox — `useAgentInvocation` (TASK-890, OD-F).
 *
 * The browser half of the published-Agent invocation plane. `@arcaai/vox-node` has been able
 * to call a published agent since TASK-865 (`hope.agents.invoke`); the browser could only
 * DISCOVER one (`useSelectableAsrAgents`). So a tenant could author, publish and assign an
 * agent and still had no first-party way to run it from a screen. The gateway routes already
 * exist — this is the client for them.
 *
 * ```tsx
 * const { invoke, stream, result, isLoading } = useAgentInvocation();
 *
 * const answer = await invoke('triage-summariser', { text: note });     // blocking JSON
 * for await (const frame of stream('triage-summariser', { text: note })) { … } // SSE
 * ```
 *
 * ## Business plane only
 *
 * This calls `/agents/*`, never `/admin/agents/*`. Authoring, publishing and assignment are
 * the admin plane — `@arcaai/vox-node`'s generated `hope.admin.agent.*`, or the console. The
 * scope this needs, `agent:invocation:write`, is mintable ON ITS OWN, so a page can hold an
 * API key that may invoke one agent family and do nothing else at all.
 *
 * ## Why `stream` uses `fetch` and not `SSEClient`
 *
 * The gateway answers `text/event-stream` on a **POST** (`?mode=stream`). `EventSource` — and
 * therefore `SSEClient`, which wraps it — can only issue a GET, and cannot set `X-API-Key`
 * either. So the streaming path reads the response body directly. That also means there is no
 * resume: unlike a workflow run, an agent invocation has no durable id to reconnect to, so a
 * dropped connection loses the generation. That is a property of the route, and pretending
 * otherwise (a silent retry that re-bills a second generation) would be worse than saying so.
 */

import { useCallback, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { AGENT_ENDPOINTS } from '../core/constants';
import { reservedRunIdentityKeysIn, ReservedRunIdentityError } from './useWorkflowRun';
import type { AgentInvocationFrame, AgentInvocationInput, AgentInvocationResult } from '../types/agent';

export interface UseAgentInvocationReturn {
  /**
   * Invoke a `TEXT_GENERATION` agent and wait for the whole answer (`?mode=blocking`).
   *
   * Throws {@link ReservedRunIdentityError} SYNCHRONOUSLY — before any request — when `input`
   * carries a server-stamped identity key.
   */
  invoke: (slug: string, input: AgentInvocationInput) => Promise<AgentInvocationResult>;
  /**
   * Invoke and consume the token stream (`?mode=stream`). Frames are relayed verbatim from the
   * TEXT service, so read the fields you know and ignore the rest.
   *
   * There is no resume: an agent invocation has no durable run id to reconnect to. If the
   * connection drops, the generation is lost — call again if you want another.
   */
  stream: (slug: string, input: AgentInvocationInput, options?: { signal?: AbortSignal }) => AsyncGenerator<AgentInvocationFrame, void, void>;
  /** The most recent blocking result, or `null`. */
  result: AgentInvocationResult | null;
  /** `true` while a blocking invocation is in flight. Streaming is caller-driven and not tracked here. */
  isLoading: boolean;
  error: Error | null;
}

/**
 * The keys the server stamps itself, refused before the request leaves.
 *
 * The same list `useWorkflowRun` enforces, imported rather than restated: a second copy is a
 * second thing to forget when the gateway's list changes. The gateway refuses these on the
 * workflow plane with a 400; an agent invocation validates against the agent's own
 * `inputSchema`, which a tenant may have authored permissively — so this refusal is the only
 * thing standing between a caller and an input that LOOKS like it addressed a consultation and
 * did not.
 */
function assertNoReservedIdentity(input: AgentInvocationInput): void {
  const offending = reservedRunIdentityKeysIn(input as Record<string, unknown>);
  if (offending.length > 0) throw new ReservedRunIdentityError(offending);
}

/** Split an SSE wire buffer into complete frames, returning the unconsumed tail. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  // `.slice(-1)[0]` rather than `.at(-1)`: this package targets a lib without `Array.prototype.at`.
  const parts = buffer.split(/\r?\n\r?\n/);
  return { frames: parts.slice(0, -1), rest: parts.slice(-1)[0] ?? '' };
}

/** The `data:` payload of one wire frame, joined across continuation lines per the SSE spec. */
function dataOf(frame: string): string | null {
  const lines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return lines.length === 0 ? null : lines.join('\n');
}

export function useAgentInvocation(): UseAgentInvocationReturn {
  const { execute, isLoading, error, apiClient } = useApiOperation('useAgentInvocation');
  const [result, setResult] = useState<AgentInvocationResult | null>(null);

  const invoke = useCallback(
    async (slug: string, input: AgentInvocationInput): Promise<AgentInvocationResult> => {
      assertNoReservedIdentity(input);
      const answer = await execute<AgentInvocationResult>('invokeAgent', (client) =>
        client.post<AgentInvocationResult>(AGENT_ENDPOINTS.INVOKE(slug, 'blocking'), input),
      );
      setResult(answer);
      return answer;
    },
    [execute],
  );

  const stream = useCallback(
    async function* (
      slug: string,
      input: AgentInvocationInput,
      options: { signal?: AbortSignal } = {},
    ): AsyncGenerator<AgentInvocationFrame, void, void> {
      assertNoReservedIdentity(input);
      if (!apiClient) throw new Error('SDK not initialized');

      // Credentials are read from the client's own public accessors rather than rebuilt here:
      // whichever class this page holds — a JWT session or a bare API key — is the one that
      // goes on the wire, and `agent:invocation:write` is mintable alone precisely so the
      // second case works with no JWT at all.
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      const token = apiClient.getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const apiKey = apiClient.getApiKey();
      if (apiKey) headers['X-API-Key'] = apiKey;
      const tenantId = apiClient.getTenantId();
      if (tenantId) headers['X-Tenant-ID'] = tenantId;

      const response = await fetch(`${apiClient.getBaseUrl()}${AGENT_ENDPOINTS.INVOKE(slug, 'stream')}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: options.signal,
      });

      // A failure must NOT read as an empty generation: a caller that sees zero frames and no
      // error will render "the agent had nothing to say" for what was actually a 403.
      if (!response.ok) throw new Error(`Agent invocation failed: HTTP ${response.status} ${response.statusText}`);
      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = splitFrames(buffer);
          buffer = rest;
          for (const raw of frames) {
            const data = dataOf(raw);
            if (data === null || data === '' || data === '[DONE]') continue;
            try {
              yield JSON.parse(data) as AgentInvocationFrame;
            } catch {
              // One unreadable frame must not tear down a stream whose remaining frames are
              // fine — and the generation is unaffected by our inability to read one.
            }
          }
        }
      } finally {
        // Releasing the lock lets the caller `break` out of the loop without leaking the body.
        reader.releaseLock();
      }
    },
    [apiClient],
  );

  return { invoke, stream, result, isLoading, error };
}
