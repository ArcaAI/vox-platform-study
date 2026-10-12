/**
 * TASK-1050 W3b — consultation details → Guardrail tab and hold banner:
 *   - the evaluation grid (time, direction, check, action taken, category, confidence, region / item,
 *     run link) with action / direction / check filters sent to the keyset route; no content;
 *   - the notices list with acknowledge (fresh If-Match);
 *   - "View withheld output" — shown only where the caller may; a 403 hides it and says why;
 *   - the hold banner offers only the allowed resumes.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { ConsultationGuardrailTab } from '../consultation-guardrail-tab';
import { ConsultationHoldBanner } from '../consultation-hold-banner';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const WARNING = {
  schemaVersion: 1,
  noticeId: 'n-warn',
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

const MEDICAL_BLOCK = {
  ...WARNING,
  noticeId: 'n-block',
  type: 'guardrail.blocked',
  action: 'block',
  direction: 'inbound',
  checks: [{ checkId: 'medical_validation', severity: 'high' }],
  messageKey: 'guardrail.blocked.not_medical',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.not_medical'],
  requiresAcknowledgement: false,
  resumable: true,
};

const ROW = {
  evaluationId: 'e-1',
  at: '2026-10-07T09:15:00.000Z',
  requestId: 'req-1',
  consultationId: 'c-1',
  runId: 'run-7',
  runKey: 'rk-7',
  nodeId: 'n_note',
  agentSlug: 'note',
  caller: 'harness.guardrail_check',
  direction: 'outbound',
  decision: 'block',
  exempt: null,
  policyVersion: 'pv',
  noticeIds: [],
  checks: [
    { checkId: 'response_safety', verdict: 'pass', actionTaken: 'none', model: 'm', latencyMs: 4, regionKeys: ['response'], items: [] },
    {
      checkId: 'leakage_judge',
      verdict: 'flag',
      actionTaken: 'block',
      category: 'system_prompt',
      confidence: 0.91,
      model: 'granite',
      latencyMs: 300,
      regionKeys: ['response'],
      items: [{ itemId: 'note-1', itemVersion: 2 }],
    },
  ],
  hasWithheldContent: true,
};

interface Call {
  method: string;
  url: URL;
  ifMatch: string | null;
  body: unknown;
}

function stub({ withheldStatus = 200, notices = [WARNING, MEDICAL_BLOCK] }: { withheldStatus?: number; notices?: unknown[] } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://t');
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        ifMatch: new Headers(init?.headers).get('if-match'),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      const path = url.pathname;
      if (path === '/api/hope/admin/consultations/c-1/guardrail-evaluations') {
        return Response.json({ consultationId: 'c-1', items: [ROW], nextCursor: null, hasMore: false, limit: 50 });
      }
      if (path.endsWith('/withheld')) {
        return withheldStatus === 200
          ? Response.json({
              evaluationId: 'e-1',
              consultationId: 'c-1',
              at: ROW.at,
              policyVersion: 'pv',
              noticeIds: [],
              content: 'withheld note body',
            })
          : Response.json({ statusCode: 403, code: 'GUARDRAIL_WITHHELD_FORBIDDEN', message: 'Forbidden' }, { status: 403 });
      }
      if (path === '/api/hope/admin/consultations/c-1/guardrail-notices')
        return Response.json({ notices, unacknowledgedNoticeIds: ['n-warn'] });
      if (path === '/api/hope/consultations/c-1' && method === 'GET') return Response.json({ id: 'c-1', version: 11 }, { headers: { etag: '"11"' } });
      if (method === 'POST') return Response.json({ ok: true });
      if (path === '/api/hope/users/me/settings') return Response.json([]);
      // grid layout persistence and anything else this screen does not care about
      return Response.json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsultationGuardrailTab', () => {
  it('renders the evaluation grid with verdicts only and a run link', async () => {
    stub();
    renderWithProviders(<ConsultationGuardrailTab consultationId="c-1" />);
    const grid = await screen.findByRole('grid', { name: /guardrail evaluations/i });
    expect(await within(grid).findByText('Leakage (judge)')).toBeDefined();
    expect(within(grid).getByText('Outbound')).toBeDefined();
    expect(within(grid).getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(within(grid).getByText(/system prompt/)).toBeDefined();
    expect(within(grid).getByText('91%')).toBeDefined();
    expect(within(grid).getByRole('link', { name: /run-7/ }).getAttribute('href')).toBe('/workflow-runs/run-7');
    expect(screen.queryByText('withheld note body')).toBeNull();
  });

  it('sends the action / direction / check filters to the keyset route', async () => {
    const calls = stub();
    renderWithProviders(<ConsultationGuardrailTab consultationId="c-1" />);
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'block' } });
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'inbound' } });
    fireEvent.change(screen.getByLabelText('Check'), { target: { value: 'medical_validation' } });
    await waitFor(() => {
      const last = calls.filter((call) => call.url.pathname.endsWith('/guardrail-evaluations')).at(-1);
      expect(last?.url.searchParams.get('action')).toBe('block');
      expect(last?.url.searchParams.get('direction')).toBe('inbound');
      expect(last?.url.searchParams.get('check')).toBe('medical_validation');
    });
  });

  it('acknowledges a warning under a fresh If-Match', async () => {
    const calls = stub();
    renderWithProviders(<ConsultationGuardrailTab consultationId="c-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^acknowledge$/i }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.pathname.endsWith('/guardrail-notices/n-warn/ack'))).toBe(true),
    );
    expect(calls.find((call) => call.method === 'POST')?.ifMatch).toBe('"11"');
  });

  it('shows withheld output on request', async () => {
    stub();
    renderWithProviders(<ConsultationGuardrailTab consultationId="c-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /view withheld output/i }));
    expect(await screen.findByText('withheld note body')).toBeDefined();
  });

  it('hides "View withheld output" after a 403 and says why', async () => {
    stub({ withheldStatus: 403 });
    renderWithProviders(<ConsultationGuardrailTab consultationId="c-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /view withheld output/i }));
    expect(await screen.findByText(/only super administrators and tenant administrators/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /view withheld output/i })).toBeNull();
  });
});

describe('ConsultationHoldBanner', () => {
  it('renders nothing unless the reason is a hold or an open blocking notice exists', async () => {
    const calls = stub({ notices: [WARNING] });
    const { container } = renderWithProviders(<ConsultationHoldBanner consultationId="c-1" processingReason="NOTE_READY" />);
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith('/guardrail-notices'))).toBe(true));
    expect(container.textContent).toBe('');
  });

  // TASK-1059 C-03: the marker can move on while a blocking notice is still open.
  it('shows the banner for an OPEN blocking notice even when the reason is not a hold', async () => {
    stub();
    renderWithProviders(<ConsultationHoldBanner consultationId="c-1" processingReason="NOTE_COVERAGE_GAPS:2" />);
    expect(await screen.findByRole('button', { name: /exclude the flagged content/i })).toBeDefined();
  });

  it('shows the hold with only the allowed resumes and resumes under a fresh If-Match', async () => {
    const calls = stub();
    renderWithProviders(<ConsultationHoldBanner consultationId="c-1" processingReason="GUARDRAIL_HOLD" />);
    const exclude = await screen.findByRole('button', { name: /exclude the flagged content/i });
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
    fireEvent.click(exclude);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.pathname.endsWith('/guardrail-hold/resume'))).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ noticeId: 'n-block', resolution: 'item_excluded' });
    expect(post?.ifMatch).toBe('"11"');
  });
});
