/**
 * TASK-1050 W3b — consultation details' guardrail reads and commands:
 *   - `GET admin/consultations/:id/guardrail-evaluations` (keyset; filters action / direction / check);
 *   - `GET admin/consultations/:id/guardrail-evaluations/:evaluationId/withheld` (403 is a privilege answer);
 *   - the business-plane notices + ack / resume under a FRESH consultation If-Match;
 *   - per-item counts derived from notices and evaluations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import {
  acknowledgeConsultationNotice,
  getWithheldContent,
  guardrailCountsByItem,
  listGuardrailEvaluations,
  resumeConsultationHold,
  type GuardrailEvaluationRow,
} from '../guardrail';

interface Call {
  url: string;
  method: string;
  ifMatch: string | null;
  body: unknown;
}

function stub(handler: (method: string, url: URL) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: String(input),
        method,
        ifMatch: new Headers(init?.headers).get('if-match'),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return handler(method, new URL(String(input), 'http://t'));
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const row = (overrides: Partial<GuardrailEvaluationRow>): GuardrailEvaluationRow => ({
  evaluationId: 'e-1',
  at: '2026-10-07T09:15:00.000Z',
  requestId: 'r',
  consultationId: 'c-1',
  runId: null,
  runKey: null,
  nodeId: null,
  agentSlug: null,
  caller: 'text.generate',
  direction: 'inbound',
  decision: 'warn',
  exempt: null,
  policyVersion: 'pv',
  noticeIds: [],
  checks: [],
  hasWithheldContent: false,
  ...overrides,
});

describe('consultation guardrail api', () => {
  it('pages the evaluations with the filters and cursor', async () => {
    const calls = stub(() => Response.json({ consultationId: 'c-1', items: [], nextCursor: null, hasMore: false, limit: 50 }));
    await listGuardrailEvaluations('c-1', { action: 'block', direction: 'outbound', check: 'leakage_judge', cursor: 'abc', limit: 50 });
    const url = new URL(calls[0]!.url, 'http://t');
    expect(url.pathname).toBe('/api/hope/admin/consultations/c-1/guardrail-evaluations');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'block',
      direction: 'outbound',
      check: 'leakage_judge',
      cursor: 'abc',
      limit: '50',
    });
  });

  it('reads the withheld output, and surfaces a 403 as a GatewayError the screen can recognise', async () => {
    stub((_method, url) =>
      url.pathname.endsWith('/withheld')
        ? Response.json({ statusCode: 403, code: 'GUARDRAIL_WITHHELD_FORBIDDEN', message: 'no' }, { status: 403 })
        : Response.json({}),
    );
    const error = await getWithheldContent('c-1', 'e-9').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(403);
  });

  it('acknowledges and resumes under a fresh consultation If-Match', async () => {
    const calls = stub((method, url) =>
      method === 'GET' && url.pathname === '/api/hope/consultations/c-1'
        ? Response.json({ id: 'c-1', version: 9 }, { headers: { etag: '"9"' } })
        : Response.json({ ok: true }),
    );
    await acknowledgeConsultationNotice('c-1', 'n-1');
    await resumeConsultationHold('c-1', { noticeId: 'b-1', resolution: 'item_excluded' });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => new URL(call.url, 'http://t').pathname)).toEqual([
      '/api/hope/consultations/c-1/guardrail-notices/n-1/ack',
      '/api/hope/consultations/c-1/guardrail-hold/resume',
    ]);
    expect(posts.every((call) => call.ifMatch === '"9"')).toBe(true);
    expect(posts[1]?.body).toEqual({ noticeId: 'b-1', resolution: 'item_excluded' });
  });

  it('counts warnings and blocks per item from notices and evaluation checks, once per notice', () => {
    const notices = [
      {
        schemaVersion: 1 as const,
        noticeId: 'n-1',
        type: 'guardrail.warning' as const,
        direction: 'inbound' as const,
        action: 'warn' as const,
        checks: [{ checkId: 'unsafe_content_judge' as const, severity: 'medium' as const }],
        itemIds: ['i-1', 'i-2'],
        messageKey: 'guardrail.warning.generic' as const,
        defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
        requiresAcknowledgement: true,
        resumable: false,
        policyVersion: 'pv',
        occurredAt: '2026-10-07T09:15:00.000Z',
      },
    ];
    const evaluations = [
      row({
        decision: 'block',
        noticeIds: [],
        checks: [
          {
            checkId: 'leakage_judge',
            verdict: 'flag',
            actionTaken: 'block',
            model: null,
            latencyMs: 1,
            regionKeys: [],
            items: [{ itemId: 'i-2', itemVersion: 1 }],
          },
        ],
      }),
    ];
    const counts = guardrailCountsByItem(notices, evaluations);
    expect(counts.get('i-1')).toEqual({ warn: 1, block: 0 });
    expect(counts.get('i-2')).toEqual({ warn: 1, block: 1 });
  });
});
