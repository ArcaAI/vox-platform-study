/**
 * LLM Playground Guardrails tab. fetch is stubbed at the network
 * boundary; covers the idle prompt, the analyze flow (POST to the safety-checks
 * proxy), and the safe/unsafe verdict with issues + confidence.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { GuardrailsTab } from '../guardrails-tab';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(response: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GuardrailsTab', () => {
  it('shows the idle prompt before any run', () => {
    stubFetch({});
    renderWithProviders(<GuardrailsTab />);
    expect(screen.getByText(/run an analysis to see the safety verdict/i)).toBeDefined();
    expect((screen.getByRole('button', { name: /analyze/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('analyzes text and renders an unsafe verdict with issues + confidence', async () => {
    const calls = stubFetch({ safe: false, issues: ['PII detected: MRN'], confidence: 0.91 });
    renderWithProviders(<GuardrailsTab />);

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Patient MRN 12345' } });
    fireEvent.change(screen.getByLabelText('Check type'), { target: { value: 'pii_detection' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));

    expect(await screen.findByText('Unsafe')).toBeDefined();
    expect(screen.getByText('PII detected: MRN')).toBeDefined();
    expect(screen.getByText(/confidence 91%/i)).toBeDefined();

    await waitFor(() => {
      const call = calls.find((c) => c.url === '/api/hope/safety-checks');
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({ text: 'Patient MRN 12345', guardrailType: 'pii_detection' });
    });
  });

  it('renders a safe verdict with no issues', async () => {
    stubFetch({ safe: true, issues: [], confidence: 0.12 });
    renderWithProviders(<GuardrailsTab />);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));
    expect(await screen.findByText('Safe')).toBeDefined();
    expect(screen.getByText(/no issues detected/i)).toBeDefined();
  });
});
