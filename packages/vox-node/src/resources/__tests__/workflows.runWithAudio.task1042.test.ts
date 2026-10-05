/**
 * TASK-1042 — `hope.workflows.runWithAudio` wired to the real routes (fetch + WebSocket faked).
 *
 * C1: the session POST carries `workflowSlug`. C2: the run POST carries `input.<audioField>.sttSessionId`.
 * C4: `audio.finalize()` closes the session (DELETE) and cancels nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { FakeWebSocket } from '../../core/__tests__/support/fake-websocket';

const SCHEMA = {
  slug: 'live-note',
  versionNumber: 1,
  triggerKinds: ['api'],
  protocols: ['http-sse'],
  modes: ['async'],
  components: {
    Workflow_live_note_Input: { type: 'object', properties: { audio: { type: 'object', properties: { sttSessionId: { type: 'string' } } } } },
  },
  asyncapi: {},
  contextSchema: null,
  reviewNodes: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('hope.workflows.runWithAudio', () => {
  it('opens a workflow-bound session, connects, then starts the run with the session id', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/workflows/live-note/schema')) return json(SCHEMA);
      if (url.endsWith('/stream/session') && method === 'POST') {
        return json({ sessionId: 'stt-9', ticket: 't', ticketExpiresAt: 4_000_000_000_000, wsUrl: '/ws/stt/stream' });
      }
      if (url.endsWith('/workflows/live-note/runs')) return json({ runId: 'run-9', status: 'started' }, 202);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const hope = new HopeClient({ baseUrl: 'https://api.example.com', apiKey: 'hope_key', fetch: fetchImpl as unknown as typeof fetch });

    const pending = hope.workflows.runWithAudio('live-note', { visitType: 'follow-up' }, { language: 'en' });
    const opened = await FakeWebSocket.opened();
    opened.emitOpen();
    const { run, audio } = await pending;

    const session = calls.find((c) => c.url.endsWith('/stream/session'))!;
    expect(session.body).toEqual({ workflowSlug: 'live-note', language: 'en' });
    const start = calls.find((c) => c.url.endsWith('/workflows/live-note/runs'))!;
    expect(start.body).toEqual({ input: { visitType: 'follow-up', audio: { sttSessionId: 'stt-9' } } });
    expect(run.runId).toBe('run-9');

    await audio.close();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/stream/session/stt-9'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/cancel'))).toBe(false);
  });
});
