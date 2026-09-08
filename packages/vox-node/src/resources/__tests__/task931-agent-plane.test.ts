/**
 * TASK-931 — the 3.1.0 agent/workflow plane changes.
 *
 * Two facts, both of them consequences of TASK-930 (INTERFACES §2, §3):
 *
 * 1. **`NAMED_ENTITY_RECOGNITION` is a task**, so `list({ task })` accepts it and
 *    the default IO shape is nameable (`NamedEntityRecognitionInput` /
 *    `NamedEntityRecognitionOutput`).
 * 2. **A service account reaches the invocation plane.** `agents.*` and
 *    `workflows.*` declared `svcScopes: []` and the SDK refused a service-account
 *    client locally rather than let it collect a 403 no grant could fix. The gateway
 *    now declares the five `svc:*` scopes, so the local refusal is wrong and gone —
 *    while the CONSULTATION-bound plane, which gained no scopes, still refuses.
 */

import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { CredentialClassError } from '../../core/errors';
import type { NamedEntityRecognitionOutput } from '../../types/agent';

function stubFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error(`stubFetch: no response configured for call ${index}`);
    return next();
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An API-key client — the business plane's original credential class. */
function apiKeyClient(fetchImpl: typeof fetch): HopeClient {
  return new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k', fetch: fetchImpl, maxRetries: 0 });
}

/** A service-account client. The first response is always the token exchange. */
function serviceAccountClient(fetchImpl: typeof fetch): HopeClient {
  return new HopeClient({
    baseUrl: 'http://localhost:8868',
    serviceAccount: { clientId: 'c', clientSecret: 's', workingTenantId: 'tenant-a' },
    fetch: fetchImpl,
    maxRetries: 0,
  });
}

const TOKEN_EXCHANGE = () => json({ accessToken: 'svc-token', expiresIn: 900 });

describe('TASK-931 — NAMED_ENTITY_RECOGNITION is an agent task', () => {
  it('filters the catalogue by it', async () => {
    const { fetch, calls } = stubFetch([() => json({ data: [] })]);

    await apiKeyClient(fetch).agents.list({ task: 'NAMED_ENTITY_RECOGNITION' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents?task=NAMED_ENTITY_RECOGNITION');
  });

  it('invokes one flat, like every other task, and types its entities', async () => {
    const output: NamedEntityRecognitionOutput = {
      entities: [{ text: 'metformin', label: 'DRUG', start: 4, end: 13, score: 0.98 }],
    };
    const { fetch, calls } = stubFetch([() => json({ output })]);

    const result = await apiKeyClient(fetch).agents.invoke<NamedEntityRecognitionOutput>('clinic-ner', { text: 'on metformin' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/agents/clinic-ner/invocations?mode=blocking');
    // Flat, never `{ input }` — the gateway validates the body against the agent's inputSchema.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'on metformin' });
    expect(result.output.entities[0]?.label).toBe('DRUG');
  });
});

describe('TASK-931 — a service account reaches the agent invocation plane', () => {
  it('lists agents, presenting the service-account token and NO X-Tenant-Id', async () => {
    const { fetch, calls } = stubFetch([TOKEN_EXCHANGE, () => json({ data: [] })]);

    await serviceAccountClient(fetch).agents.list({ task: 'NAMED_ENTITY_RECOGNITION' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/auth/service-token');
    const headers = new Headers(calls[1]!.init.headers);
    expect(headers.get('X-Service-Account-Token')).toBe('svc-token');
    // `workingTenantId` binds at EXCHANGE — a second tenant assertion per request is exactly
    // the mistake the construction-time guard exists to prevent.
    expect(headers.get('X-Tenant-Id')).toBeNull();
    expect(headers.get('X-API-Key')).toBeNull();
  });

  it('invokes an agent', async () => {
    const { fetch, calls } = stubFetch([TOKEN_EXCHANGE, () => json({ output: { text: 'ok' } })]);

    const result = await serviceAccountClient(fetch).agents.invoke('note-writer', { text: 'hi' });

    expect(result.output).toEqual({ text: 'ok' });
    expect(calls[1]!.url).toBe('http://localhost:8868/api/v1/agents/note-writer/invocations?mode=blocking');
  });
});

describe('TASK-931 — a service account reaches the workflow invocation plane', () => {
  it('lists, starts and reads a run', async () => {
    const { fetch, calls } = stubFetch([
      TOKEN_EXCHANGE,
      () => json({ data: [] }),
      () => json({ runId: 'run-1', slug: 'triage', status: 'accepted' }, 202),
      () => json({ runId: 'run-1', slug: 'triage', status: 'COMPLETED', stages: [] }),
    ]);
    const hope = serviceAccountClient(fetch);

    await hope.workflows.list();
    await hope.workflows.run('triage', { input: { note: 'n' } });
    await hope.workflows.getRun('triage', 'run-1');

    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:8868/api/v1/auth/service-token',
      'http://localhost:8868/api/v1/workflows',
      'http://localhost:8868/api/v1/workflows/triage/runs',
      'http://localhost:8868/api/v1/workflows/triage/runs/run-1',
    ]);
  });

  it('reads and decides a human review', async () => {
    const { fetch, calls } = stubFetch([TOKEN_EXCHANGE, () => json({ exists: true, status: 'pending' }), () => json({ accepted: true })]);
    const hope = serviceAccountClient(fetch);

    await hope.workflows.reviews.get('triage', 'run-1', 'n1');
    await hope.workflows.reviews.decide('triage', 'run-1', 'n1', { decision: 'approved' });

    expect(calls[1]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs/run-1/reviews/n1');
    expect(calls[2]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs/run-1/reviews/n1/decide');
  });

  it('still REFUSES the consultation-bound plane, which gained no service-account scope', async () => {
    const { fetch, calls } = stubFetch([TOKEN_EXCHANGE]);
    const hope = serviceAccountClient(fetch);

    await expect(hope.consultations.workflows.list('c1')).rejects.toBeInstanceOf(CredentialClassError);
    await expect(hope.consultations.workflows.run('c1', 'triage', { input: {} })).rejects.toBeInstanceOf(CredentialClassError);
    // Refused at the call site: nothing reached the network, not even the token exchange.
    expect(calls).toHaveLength(0);
  });
});
