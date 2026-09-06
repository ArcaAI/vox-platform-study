/**
 * TASK-863 — Agents API module: paths and envelopes verified against apps/api
 * AgentAdminController / AgentAssignmentAdminController (If-Match OCC on PATCH and on
 * assignment DELETE, the lifecycle POSTs). TASK-890 OD-M: the list no longer sends
 * `includeTemplates` — the SYSTEM reference set is cloned into the tenant at provisioning, never
 * read live across tenants, so `GET admin/agents` answers this tenant's own rows only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, deprecateAgent, finalizeAgentTest, listAgents, newAgentVersion, publishAgent, removeAgentAssignment, testAgent, updateAgent, validateAgent } from '../client';
import { agentKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, headers });
      return Response.json({ id: 'a-1' }, { headers: { etag: '"4"' } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('agents client', () => {
  it('lists with an optional task filter, and never sends includeTemplates (OD-M — no cross-tenant SYSTEM read)', async () => {
    const calls = installFetchMock();
    await listAgents('SPEECH_TO_TEXT');
    expect(calls[0].url).toContain('/api/hope/admin/agents?');
    expect(calls[0].url).toContain('task=SPEECH_TO_TEXT');
    expect(calls[0].url).not.toContain('includeTemplates');
  });

  it('the draft-agent test bench posts to :id/test and :id/test/finalize', async () => {
    const calls = installFetchMock();
    await testAgent('a-1', { input: { text: 'hi' }, dryRun: true });
    await finalizeAgentTest('a-1', { taskId: 't-1' });
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://t').pathname])).toEqual([
      ['POST', '/api/hope/admin/agents/a-1/test'],
      ['POST', '/api/hope/admin/agents/a-1/test/finalize'],
    ]);
    expect(calls[0].body).toEqual({ input: { text: 'hi' }, dryRun: true });
    expect(calls[1].body).toEqual({ taskId: 't-1' });
  });

  it('PATCH carries If-Match and the derived expectedVersion', async () => {
    const calls = installFetchMock();
    await updateAgent('a-1', { name: 'x' }, '"3"');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].headers['if-match']).toBe('"3"');
    expect(calls[0].body).toEqual({ name: 'x', expectedVersion: 3 });
  });

  it('routes the lifecycle transitions to their POST routes', async () => {
    const calls = installFetchMock();
    await createAgent({ slug: 's', name: 'n', task: 'TEXT_GENERATION', modelId: 'm' });
    await validateAgent('a-1');
    await publishAgent('a-1', { activate: false });
    await newAgentVersion('a-1', { name: 'v2' });
    await deprecateAgent('a-1');
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://t').pathname])).toEqual([
      ['POST', '/api/hope/admin/agents'],
      ['POST', '/api/hope/admin/agents/a-1/validate'],
      ['POST', '/api/hope/admin/agents/a-1/publish'],
      ['POST', '/api/hope/admin/agents/a-1/versions'],
      ['POST', '/api/hope/admin/agents/a-1/deprecate'],
    ]);
    expect(calls[2].body).toEqual({ activate: false });
  });

  it('assignment DELETE carries If-Match from the row version', async () => {
    const calls = installFetchMock();
    await removeAgentAssignment('as-1', 7, 'why');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].headers['if-match']).toBe('"7"');
    expect(calls[0].url).toContain('/api/hope/admin/agent-assignments/as-1?');
    expect(calls[0].url).toContain('reason=why');
  });

  it('roots every key under agent-entities (the prompt-template feature keeps prompt-templates)', () => {
    expect(agentKeys.root).toEqual(['agent-entities']);
    expect(agentKeys.list('TEXT_TO_SPEECH')).toEqual(['agent-entities', 'list', 'TEXT_TO_SPEECH']);
  });
});
