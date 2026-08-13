/**
 * Contract test: a foreign/unknown consultation id must
 * yield {@link NotFoundError}, never {@link PermissionError}.
 *
 * HOPE's tenancy posture is 404-over-403 (`.claude/rules/05-nestjs-api.md`
 * "Cross-tenant access returns 404, never 403"): a real consultation owned
 * by a different tenant is, on the wire, byte-identical to one that never
 * existed — the gateway never emits 403 for this case at all. These fixtures
 * exercise the SDK's OWN response→error mapping (`core/errors.ts#fromResponse`)
 * against every route this lane implements that takes a consultation/summary
 * id, proving none of them ever manufacture a `PermissionError` out of a 404
 * body — whatever the body's message happens to say.
*/
import { describe, expect, it, vi } from 'vitest';

import { NotFoundError, PermissionError } from '../../core/errors';
import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';
import { JobsResource } from '../jobs';

function notFound(message: string): Response {
  return new Response(JSON.stringify({ message }), { status: 404, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function newTransport(fetchImpl: ReturnType<typeof fetchMock>): Transport {
  return new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
}

async function assertNotFoundNeverPermission(run: () => Promise<unknown>): Promise<void> {
  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NotFoundError);
  expect(error).not.toBeInstanceOf(PermissionError);
  expect((error as Error).message).toMatch(/different tenant/i);
}

describe('404-over-403 — cross-tenant consultation access', () => {
  it('consultations.get(foreignId) → NotFoundError', async () => {
    const transport = newTransport(fetchMock(async () => notFound('Consultation not found')));
    const resource = new ConsultationsResource(transport);
    await assertNotFoundNeverPermission(() => resource.get('foreign-consultation-id'));
  });

  it('consultations.summaries.list(foreignId) → NotFoundError', async () => {
    const transport = newTransport(fetchMock(async () => notFound('Consultation not found')));
    const resource = new ConsultationsResource(transport);
    await assertNotFoundNeverPermission(() => resource.summaries.list('foreign-consultation-id'));
  });

  it('consultations.summaries.generate(foreignId) → NotFoundError', async () => {
    const transport = newTransport(fetchMock(async () => notFound('Consultation not found')));
    const resource = new ConsultationsResource(transport);
    await assertNotFoundNeverPermission(() => resource.summaries.generate('foreign-consultation-id', {}));
  });

  it('consultations.summaries.update(foreignId, summaryId) → NotFoundError', async () => {
    const transport = newTransport(fetchMock(async () => notFound('Consultation not found')));
    const resource = new ConsultationsResource(transport);
    await assertNotFoundNeverPermission(() => resource.summaries.update('foreign-consultation-id', 'sum-1', { content: 'x' }));
  });

  it('jobs.get(foreignJobId) → NotFoundError', async () => {
    const transport = newTransport(fetchMock(async () => notFound('Job not found')));
    const jobs = new JobsResource(transport);
    const error = await jobs.get('foreign-job-id').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(PermissionError);
    expect((error as Error).message).toMatch(/different tenant/i);
  });
});
