/**
 * Prompt Inspector — a dry run of what a consultation's LLM call would be composed into, and the
 * stored (encrypted) records of what was actually sent. Codes against the gateway lane's contract:
 * `POST admin/consultations/:id/prompt-preview`, `GET admin/composed-prompts?consultationId=` and
 * `GET admin/composed-prompts/:id`, through the BFF proxy.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ConsultationDetailPanel } from '../consultation-detail-panel';
import { PromptInspector } from '../prompt-inspector';

const CLOUD_PREVIEW = {
  system: 'You are a clinical scribe.\n\nWrite in English.',
  user: '<<EXTERNAL_DATA key="transcript" label="Transcript">>\nJohn Smith, 54, chest pain.\n<<END_EXTERNAL_DATA>>',
  locality: 'cloud',
  providerView: {
    system: 'You are a clinical scribe.\n\nWrite in English.\n\nTokens like [PERSON_1] are placeholders.',
    user: '<<EXTERNAL_DATA key="transcript" label="Transcript">>\n[PERSON_1], 54, chest pain.\n<<END_EXTERNAL_DATA>>',
  },
  egressPreview: { detected: { person: 2, medical_record_number: 1 }, redacted: 3 },
  tokenEstimate: { system: 12, user: 40 },
  resolvedFrom: 'agent:soap-writer',
  selected: ['base', 'revisit'],
  excluded: [{ key: 'pediatric', reason: 'condition_false' }],
  blocks: [
    { key: 'transcript', chars: 1200, truncated: true },
    { key: 'vitals', chars: 80, truncated: false },
  ],
};

const RECORDS = [
  { id: 'cp-1', consultationId: 'c-1', agentSlug: 'soap-writer', phase: 'finalize', provider: 'openai', locality: 'cloud', sha256: 'abc123', createdAt: '2026-10-01T10:00:00.000Z' },
];
const RECORD_DETAIL = { ...RECORDS[0], system: 'Stored system text', user: 'Stored user text' };

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function stub(preview: unknown = CLOUD_PREVIEW): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const call = { path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (url.pathname === '/api/hope/admin/consultations/c-1/prompt-preview') return Response.json(preview);
      if (url.pathname === '/api/hope/admin/composed-prompts' && url.searchParams.get('consultationId') === 'c-1') return Response.json(RECORDS);
      if (url.pathname === '/api/hope/admin/composed-prompts/cp-1') return Response.json(RECORD_DETAIL);
      if (url.pathname === '/api/hope/admin/consultations/c-1') {
        return Response.json({
          id: 'c-1',
          patientId: 'patient-123456',
          doctorId: 'd-1',
          status: 'COMPLETED',
          createdAt: '2026-10-01T09:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          contextItems: [],
        });
      }
      return Response.json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PromptInspector', () => {
  it('previews a phase and shows raw vs provider view, locality, detected labels and truncated blocks', async () => {
    const calls = stub();
    renderWithProviders(<PromptInspector consultationId="c-1" />);
    fireEvent.click(screen.getByLabelText('Phase'));
    fireEvent.click(await screen.findByRole('option', { name: 'Finalize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview prompt' }));

    await screen.findByRole('region', { name: 'As composed' });
    expect(screen.getAllByText('Cloud provider').length).toBeGreaterThan(0);
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/api/hope/admin/consultations/c-1/prompt-preview');
    expect(post?.body).toEqual({ phase: 'finalize' });

    const composed = screen.getByRole('region', { name: 'As composed' });
    const provider = screen.getByRole('region', { name: 'Sent to the provider' });
    expect(composed.textContent).toContain('John Smith');
    expect(provider.textContent).toContain('[PERSON_1]');
    expect(provider.textContent).not.toContain('John Smith');

    const detected = screen.getByRole('list', { name: 'Detected labels' });
    expect(within(detected).getByText('person').parentElement?.textContent).toContain('2');
    expect(screen.getByText(/3 values redacted/)).toBeTruthy();
    const blocks = screen.getByRole('table', { name: 'Data blocks' });
    expect(within(blocks).getByText('transcript').closest('tr')?.textContent).toMatch(/Truncated/);
    expect(screen.getByText(/condition_false/)).toBeTruthy();
  });

  it('sends the agent slug when one is named', async () => {
    const calls = stub();
    renderWithProviders(<PromptInspector consultationId="c-1" />);
    fireEvent.change(screen.getByLabelText('Agent slug (optional)'), { target: { value: 'soap-writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview prompt' }));
    await screen.findByRole('region', { name: 'As composed' });
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ phase: 'live', agentSlug: 'soap-writer' });
  });

  it('says a local provider receives the composed prompt unchanged', async () => {
    stub({ ...CLOUD_PREVIEW, locality: 'local', providerView: null });
    renderWithProviders(<PromptInspector consultationId="c-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview prompt' }));
    await screen.findByText('Local provider');
    expect(screen.getByText(/receives the composed prompt unchanged/)).toBeTruthy();
  });

  it('lists stored records and opens one decrypted', async () => {
    stub();
    renderWithProviders(<PromptInspector consultationId="c-1" />);
    const records = await screen.findByRole('table', { name: 'Stored prompts' });
    expect(within(records).getByText('openai')).toBeTruthy();
    fireEvent.click(within(records).getByRole('button', { name: /View/ }));
    await waitFor(() => expect(screen.getByText('Stored user text')).toBeTruthy());
  });

  it('is a tab on the consultation detail', async () => {
    stub();
    renderWithProviders(<ConsultationDetailPanel consultationId="c-1" onOpenChange={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Prompt inspector' }), { button: 0 });
    expect(await screen.findByRole('button', { name: 'Preview prompt' })).toBeTruthy();
  });

  it('has no axe violations with a preview shown', async () => {
    stub();
    const { container } = renderWithProviders(<PromptInspector consultationId="c-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview prompt' }));
    await screen.findByRole('region', { name: 'As composed' });
    await screen.findByRole('table', { name: 'Stored prompts' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
