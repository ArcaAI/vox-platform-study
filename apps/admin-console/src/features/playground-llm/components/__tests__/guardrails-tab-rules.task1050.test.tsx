/**
 * TASK-1050 W3b — LLM Playground → Guardrails → "Test my rules": screens text inbound or outbound under
 * the tenant's EFFECTIVE rules and shows every check's verdict, configured action and action taken, plus
 * the notices. The free-form analyzer stays.
 *
 * The route is a TODO seam (`screenWithEffectiveRules`): no admin gateway route screens with effective
 * rules today, so a 404 reads as "not available on this gateway yet", never as a failure of the rules.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { GuardrailsTab } from '../guardrails-tab';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(status: number, response: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCREEN_RESULT = {
  direction: 'outbound',
  decision: 'warn',
  policyVersion: 'pv-7',
  checks: [
    { checkId: 'response_safety', verdict: 'pass', action: 'block', actionTaken: 'none' },
    { checkId: 'clinical_safety_judge', verdict: 'flag', action: 'warn', actionTaken: 'warn', category: 'dangerous_dosing', confidence: 0.82 },
    { checkId: 'leakage_judge', verdict: 'undetermined', action: 'block', actionTaken: 'unverified' },
  ],
  notices: [
    {
      schemaVersion: 1,
      noticeId: 'n-1',
      type: 'guardrail.warning',
      direction: 'outbound',
      action: 'warn',
      checks: [{ checkId: 'clinical_safety_judge', category: 'dangerous_dosing', severity: 'high' }],
      itemIds: [],
      messageKey: 'guardrail.warning.generic',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
      requiresAcknowledgement: false,
      resumable: false,
      policyVersion: 'pv-7',
      occurredAt: '2026-10-07T09:15:00.000Z',
    },
  ],
};

describe('GuardrailsTab — Test my rules', () => {
  it('keeps the free-form analyzer beside it', () => {
    stubFetch(200, {});
    renderWithProviders(<GuardrailsTab />);
    expect(screen.getByText('Analyze text')).toBeDefined();
    expect(screen.getByRole('heading', { name: /test my rules/i })).toBeDefined();
  });

  it('screens outbound text under the effective rules and shows every check', async () => {
    const calls = stubFetch(200, SCREEN_RESULT);
    renderWithProviders(<GuardrailsTab />);
    const card = screen.getByRole('region', { name: /test my rules/i });
    fireEvent.change(within(card).getByLabelText('Text to screen'), { target: { value: 'Give 50 mg every hour.' } });
    fireEvent.change(within(card).getByLabelText('Direction'), { target: { value: 'outbound' } });
    fireEvent.click(within(card).getByRole('button', { name: /screen with my rules/i }));

    const table = await within(card).findByRole('table', { name: /checks/i });
    expect(within(table).getByText('Clinical safety (judge)')).toBeDefined();
    expect(within(table).getByText('Flagged')).toBeDefined();
    expect(within(table).getByText('Could not run')).toBeDefined();
    expect(within(table).getAllByText('Warned').length).toBeGreaterThan(0);
    expect(within(table).getByText('Unverified')).toBeDefined();
    expect(within(card).getByText(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'])).toBeDefined();

    await waitFor(() => {
      const call = calls.find((entry) => entry.url === '/api/hope/admin/guardrail/screen');
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({ direction: 'outbound', text: 'Give 50 mg every hour.' });
    });
  });

  it('says the route is not available yet on a 404', async () => {
    stubFetch(404, { statusCode: 404, code: 'HTTP.NOT_FOUND', message: 'Cannot POST' });
    renderWithProviders(<GuardrailsTab />);
    const card = screen.getByRole('region', { name: /test my rules/i });
    fireEvent.change(within(card).getByLabelText('Text to screen'), { target: { value: 'x' } });
    fireEvent.click(within(card).getByRole('button', { name: /screen with my rules/i }));
    expect(await within(card).findByText(/not available on this gateway yet/i)).toBeDefined();
  });
});
