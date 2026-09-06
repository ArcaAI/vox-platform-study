/**
 * TASK-890 L7 — `hope.workflows.schema()` and `hope.workflows.reviews.*`.
 *
 * Pinned to the gateway routes, not to invented shapes:
 *
 * | Asserted | Source of truth |
 * |---|---|
 * | `GET /workflows/{slug}/schema` | `apps/api/route-manifest.json` (already shipped, `workflow:definition:read`) |
 * | `…/runs/{runId}/reviews/{nodeId}[/decide]` | `apps/api/src/modules/workflows/workflows.controller.ts` |
 * | `reviewerId` is never sent | `ReviewDecisionRequest` declares no such field; the gateway 400s an undeclared one |
 */

import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { CredentialClassError } from '../../core/errors';

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

function client(responses: Array<() => Response>) {
  const { fetch, calls } = stubFetch(responses);
  return { hope: new HopeClient({ baseUrl: 'https://api.example.com', apiKey: 'hope_key', fetch }), calls };
}

const SCHEMA = {
  slug: 'triage',
  versionNumber: 3,
  triggerKinds: ['api', 'webhook'],
  protocols: ['http-sse', 'socket'],
  modes: ['async', 'stream', 'socket'],
  components: { Workflow_triage_Input: { title: 'Workflow_triage_Input', type: 'object' } },
  asyncapi: { asyncapi: '3.0.0' },
};

describe('hope.workflows.schema', () => {
  it('GETs /workflows/{slug}/schema and returns the description verbatim', async () => {
    const { hope, calls } = client([() => json(SCHEMA)]);

    const schema = await hope.workflows.schema('triage');

    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/workflows/triage/schema');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(schema).toEqual(SCHEMA);
  });

  it('percent-encodes a slug that carries path characters', async () => {
    const { hope, calls } = client([() => json(SCHEMA)]);
    await hope.workflows.schema('a/b');
    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/workflows/a%2Fb/schema');
  });

  it('refuses a service-account client — this is the API-key plane', async () => {
    const { fetch } = stubFetch([() => json(SCHEMA)]);
    const hope = new HopeClient({ baseUrl: 'https://api.example.com', serviceAccount: { clientId: 'c', clientSecret: 's' }, fetch });
    await expect(hope.workflows.schema('triage')).rejects.toBeInstanceOf(CredentialClassError);
  });
});

describe('hope.workflows.list — the contract travels with the catalogue', () => {
  it('surfaces inputSchema / outputSchema / protocols / triggerKinds', async () => {
    const summary = {
      slug: 'triage',
      name: 'Triage',
      description: null,
      paletteKey: 'core',
      versionNumber: 3,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      protocols: ['http-sse'],
      triggerKinds: ['api'],
    };
    const { hope } = client([() => json({ data: [summary] })]);

    const [first] = await hope.workflows.list();

    expect(first).toEqual(summary);
  });
});

describe('hope.workflows.reviews', () => {
  const REVIEW = { runId: 'run-1', nodeId: 'n_review', exists: true, phase: 'WAITING', escalations: 0, decided: false, decision: null };

  it('GETs the review state at …/runs/{runId}/reviews/{nodeId}', async () => {
    const { hope, calls } = client([() => json(REVIEW)]);

    const review = await hope.workflows.reviews.get('triage', 'run-1', 'n_review');

    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/workflows/triage/runs/run-1/reviews/n_review');
    expect(review).toEqual(REVIEW);
  });

  it('POSTs the decision to …/reviews/{nodeId}/decide with the body verbatim', async () => {
    const { hope, calls } = client([() => json({ runId: 'run-1', nodeId: 'n_review', decision: 'approved', signaled: true, reviewerId: 'u1' })]);

    const result = await hope.workflows.reviews.decide('triage', 'run-1', 'n_review', { decision: 'approved', comment: 'ok' });

    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/workflows/triage/runs/run-1/reviews/n_review/decide');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: 'approved', comment: 'ok' });
    expect(result.signaled).toBe(true);
  });

  it('never puts a reviewer identity on the wire, even when one is handed in', async () => {
    const { hope, calls } = client([() => json({ runId: 'run-1', nodeId: 'n', decision: 'approved', signaled: true, reviewerId: 'u1' })]);

    await hope.workflows.reviews.decide('triage', 'run-1', 'n', { decision: 'approved', reviewerId: 'someone-else' } as never);

    // The gateway would answer 400 (its DTO forbids undeclared properties). Dropping it here
    // turns a confusing round trip into a field that simply cannot be sent.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: 'approved' });
  });

  it('forwards an editedPayload when the caller supplies one', async () => {
    const { hope, calls } = client([() => json({ runId: 'r', nodeId: 'n', decision: 'approved', signaled: true, reviewerId: null })]);

    await hope.workflows.reviews.decide('triage', 'run-1', 'n', { decision: 'approved', editedPayload: { summary: 'fixed' } });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: 'approved', editedPayload: { summary: 'fixed' } });
  });

  it('percent-encodes the run id and the node id', async () => {
    const { hope, calls } = client([() => json(REVIEW)]);
    await hope.workflows.reviews.get('triage', 'run/1', 'n review');
    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/workflows/triage/runs/run%2F1/reviews/n%20review');
  });

  it('refuses a service-account client on both methods', async () => {
    const { fetch } = stubFetch([() => json(REVIEW)]);
    const hope = new HopeClient({ baseUrl: 'https://api.example.com', serviceAccount: { clientId: 'c', clientSecret: 's' }, fetch });

    await expect(hope.workflows.reviews.get('triage', 'run-1', 'n')).rejects.toBeInstanceOf(CredentialClassError);
    await expect(hope.workflows.reviews.decide('triage', 'run-1', 'n', { decision: 'approved' })).rejects.toBeInstanceOf(CredentialClassError);
  });
});
