/**
 * TASK-1050 W3b — the consultation playground's guardrail verbs over the BFF proxy.
 *
 * Every command carries the CONSULTATION's If-Match, read fresh right before the write: this screen
 * drives start/stop through its own REST calls, so a version cached by the SDK store would be stale and
 * every resume / approve would 412.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { acknowledgeGuardrailNotice, approveConsultation, listGuardrailNotices, resumeGuardrailHold } from '../guardrail';

interface Call {
  url: string;
  method: string;
  ifMatch: string | null;
  body: unknown;
}

function stub(routes: Record<string, { status?: number; body: unknown; etag?: string }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({ url, method, ifMatch: headers.get('if-match'), body: init?.body ? JSON.parse(init.body as string) : undefined });
      const route = routes[`${method} ${new URL(url, 'http://t').pathname}`];
      if (!route) throw new Error(`unrouted ${method} ${url}`);
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json', ...(route.etag ? { etag: route.etag } : {}) },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const NOTICE = {
  schemaVersion: 1,
  noticeId: 'n-1',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'clinical_safety_judge', category: 'dangerous_dosing', severity: 'high' }],
  itemIds: ['note-1'],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
  status: 'open',
};

describe('consultation guardrail api', () => {
  it('lists the notices, dropping any that fail the contract', async () => {
    stub({
      'GET /api/hope/consultations/c-1/guardrail-notices': {
        body: { notices: [NOTICE, { ...NOTICE, noticeId: 'n-2', defaultMessage: 'free text' }], unacknowledgedNoticeIds: ['n-1'] },
      },
    });
    const result = await listGuardrailNotices('c-1');
    expect(result.notices.map((notice) => notice.noticeId)).toEqual(['n-1']);
    expect(result.notices[0]?.status).toBe('open');
    expect(result.unacknowledgedNoticeIds).toEqual(['n-1']);
  });

  it('approves the consultation with acknowledgeGuardrailNotices under a fresh If-Match', async () => {
    const calls = stub({
      'GET /api/hope/consultations/c-1': { body: { id: 'c-1', version: 7 }, etag: '"7"' },
      'POST /api/hope/consultations/c-1/approve': { body: { id: 'c-1', status: 'APPROVED', acknowledgedNotices: [{ noticeId: 'n-1' }] } },
    });
    const result = await approveConsultation('c-1', { overrideSafetyFlag: false, acknowledgeGuardrailNotices: true });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.ifMatch).toBe('"7"');
    expect(post?.body).toEqual({ acknowledgeGuardrailNotices: true });
    expect(result.acknowledgedNotices).toHaveLength(1);
  });

  it('resolves an inbound hold and approves in ONE action (resolveHold + acknowledgeGuardrailNotices)', async () => {
    const calls = stub({
      'GET /api/hope/consultations/c-1': { body: { id: 'c-1', version: 8 }, etag: '"8"' },
      'POST /api/hope/consultations/c-1/approve': { body: { id: 'c-1', status: 'APPROVED' } },
    });
    await approveConsultation('c-1', {
      acknowledgeGuardrailNotices: true,
      resolveHold: { noticeId: 'b-1', resolution: 'item_excluded' },
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.ifMatch).toBe('"8"');
    expect(post?.body).toEqual({ acknowledgeGuardrailNotices: true, resolveHold: { noticeId: 'b-1', resolution: 'item_excluded' } });
  });

  it('resumes a hold with the chosen resolution under a fresh If-Match', async () => {
    const calls = stub({
      'GET /api/hope/consultations/c-1': { body: { id: 'c-1', version: 3 }, etag: '"3"' },
      'POST /api/hope/consultations/c-1/guardrail-hold/resume': {
        body: { id: 'c-1', status: 'PAUSED', processing: 'IDLE', resolvedNoticeId: 'b-1' },
      },
    });
    await resumeGuardrailHold('c-1', { noticeId: 'b-1', resolution: 'item_excluded' });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.ifMatch).toBe('"3"');
    expect(post?.body).toEqual({ noticeId: 'b-1', resolution: 'item_excluded' });
  });

  it('acknowledges one notice under a fresh If-Match, falling back to the body version', async () => {
    const calls = stub({
      'GET /api/hope/consultations/c-1': { body: { id: 'c-1', version: 4 } },
      'POST /api/hope/consultations/c-1/guardrail-notices/n-1/ack': { body: { notice: NOTICE, acknowledgement: { noticeId: 'n-1' } } },
    });
    await acknowledgeGuardrailNotice('c-1', 'n-1');
    expect(calls.find((call) => call.method === 'POST')?.ifMatch).toBe('"4"');
  });
});
