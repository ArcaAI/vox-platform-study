/**
 * TASK-1050 W2d — the client throws the typed guardrail errors for the 422 block and the retryable 503, and leaves
 * every other mapping alone.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { EgressRedactionUnavailableError, GUARDRAIL_BLOCKED_PROBLEM_TYPE, GuardrailBlockedError } from '../guardrail';
import { mockFetch, createMockErrorResponse, createMockLogger } from '../../__tests__/setup';

const NOTICE = {
  schemaVersion: 1,
  noticeId: 'n1',
  type: 'guardrail.blocked',
  direction: 'outbound',
  action: 'block',
  checks: [],
  itemIds: [],
  messageKey: 'guardrail.blocked.outbound',
  defaultMessage: 'A safety check withheld the generated content. Review it to continue.',
  requiresAcknowledgement: true,
  resumable: true,
  policyVersion: 'pv',
  occurredAt: 't',
};

const withBody = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response =>
  createMockErrorResponse(status, 'x', { json: () => Promise.resolve(body), headers: new Headers({ 'content-type': 'application/json', ...headers }) });

describe('AgenticClient — guardrail errors', () => {
  let client: AgenticClient;
  beforeEach(() => {
    client = new AgenticClient({ baseUrl: 'https://api.example.com', apiKey: 'k', tenantId: 't' }, createMockLogger());
  });
  afterEach(() => vi.clearAllMocks());

  it('a 422 guardrail problem throws GuardrailBlockedError (still an AgenticError) with the notice and the legacy code', async () => {
    mockFetch.mockResolvedValueOnce(
      withBody(422, { type: GUARDRAIL_BLOCKED_PROBLEM_TYPE, title: 't', error_code: 'CONTENT_BLOCKED', guardrailNotice: NOTICE, guardrailEvaluationIds: ['e1'] }),
    );
    const error = await client.post('/api/generate', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error).toBeInstanceOf(AgenticError);
    expect((error as GuardrailBlockedError).notice?.noticeId).toBe('n1');
    expect((error as GuardrailBlockedError).evaluationIds).toEqual(['e1']);
    expect((error as GuardrailBlockedError).context?.code).toBe('CONTENT_BLOCKED');
    expect((error as GuardrailBlockedError).context?.status).toBe(422);
  });

  it('a 503 EGRESS_REDACTION_UNAVAILABLE throws a retryable error carrying Retry-After', async () => {
    mockFetch.mockResolvedValueOnce(withBody(503, { code: 'EGRESS_REDACTION_UNAVAILABLE', message: 'down' }, { 'retry-after': '2' }));
    const error = (await client.post('/api/generate', {}).catch((e: unknown) => e)) as EgressRedactionUnavailableError;
    expect(error).toBeInstanceOf(EgressRedactionUnavailableError);
    expect(error.retryable).toBe(true);
    expect(error.context?.retryAfter).toBe('2');
  });

  it('other statuses are unchanged', async () => {
    mockFetch.mockResolvedValueOnce(createMockErrorResponse(403, 'Forbidden'));
    await expect(client.get('/api/x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mockFetch.mockResolvedValueOnce(withBody(422, { code: 'VALIDATION', message: 'bad' }));
    const error = await client.post('/api/x', {}).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GuardrailBlockedError);
    expect(error).toBeInstanceOf(AgenticError);
  });
});
