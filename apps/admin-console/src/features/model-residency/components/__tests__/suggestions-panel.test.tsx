/**
 * TASK-1051 lane C1 — the Recommendations rail (artboard 01, F4): one standing
 * row per model+action, first seen / last confirmed / repeats, Apply and
 * Dismiss.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { SuggestionsPanel } from '../suggestions-panel';
import { LIVE_WHISPER, LMS, makeSuggestion, NLP, PINNED_NOT_LOADED, STT } from './residency-test-data';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handle: (call: Call) => Response | unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const result = handle(call);
      if (result === undefined) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const NOW = new Date('2026-10-07T10:00:00Z');
const SERVICES = [STT, LMS, NLP];

describe('SuggestionsPanel', () => {
  it('shows an empty state with no recommendations', () => {
    renderWithProviders(<SuggestionsPanel suggestions={[]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Recommendations (0)' })).toBeDefined();
    expect(screen.getByText('No recommendations')).toBeDefined();
  });

  it('renders a verb badge, the sentence, first seen / last confirmed and the repeat count', () => {
    renderWithProviders(
      <SuggestionsPanel suggestions={[makeSuggestion()]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />,
    );
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Load')).toBeDefined();
    expect(within(row).getByText(/pinned for 10 live ASR agents/)).toBeDefined();
    expect(within(row).getByText('First seen 2 h ago · last confirmed 1 min ago · ×21')).toBeDefined();
  });

  it('omits the repeat count for a single sighting', () => {
    renderWithProviders(
      <SuggestionsPanel suggestions={[makeSuggestion({ repeats: 1 })]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />,
    );
    expect(screen.getByText('First seen 2 h ago · last confirmed 1 min ago')).toBeDefined();
  });

  it('Apply on a load opens the load preview for that model; on an unload, the unload dialog', () => {
    const onApplyLoad = vi.fn();
    const onApplyUnload = vi.fn();
    renderWithProviders(
      <SuggestionsPanel
        suggestions={[makeSuggestion(), makeSuggestion({ id: 'sugg-2', action: 'unload', modelRef: 'whisper-ml-en', text: 'Unload it.' })]}
        services={SERVICES}
        onApplyLoad={onApplyLoad}
        onApplyUnload={onApplyUnload}
        now={NOW}
      />,
    );
    const [loadRow, unloadRow] = screen.getAllByRole('listitem');
    fireEvent.click(within(loadRow!).getByRole('button', { name: /Apply/ }));
    expect(onApplyLoad).toHaveBeenCalledWith(STT, PINNED_NOT_LOADED);
    fireEvent.click(within(unloadRow!).getByRole('button', { name: /Apply/ }));
    expect(onApplyUnload).toHaveBeenCalledWith(STT, LIVE_WHISPER);
  });

  it('Apply on a pin calls PUT pins and toasts', async () => {
    const calls = stubFetch((call) => (call.url.endsWith('/admin/model-residency/pins') ? { ok: true } : undefined));
    renderWithProviders(
      <SuggestionsPanel
        suggestions={[makeSuggestion({ action: 'pin', modelRef: 'whisper-ml-en' })]}
        services={SERVICES}
        onApplyLoad={vi.fn()}
        onApplyUnload={vi.fn()}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pinned ArcaAI Whisper ml-en.'));
    const put = calls.find((call) => call.url.endsWith('/pins'));
    expect(put).toMatchObject({ method: 'PUT', body: { service: 'stt', modelRef: 'whisper-ml-en', pinned: true } });
  });

  it('Dismiss posts the dismiss route for that suggestion and toasts', async () => {
    const calls = stubFetch((call) => (call.url.endsWith('/suggestions/sugg-1/dismiss') ? { id: 'sugg-1', dismissed: true } : undefined));
    renderWithProviders(
      <SuggestionsPanel suggestions={[makeSuggestion()]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Recommendation dismissed.'));
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/admin/model-residency/suggestions/sugg-1/dismiss'))).toBe(true);
  });

  it('toasts the error when dismiss fails', async () => {
    stubFetch(() => Response.json({ message: 'nope' }, { status: 500 }));
    renderWithProviders(
      <SuggestionsPanel suggestions={[makeSuggestion()]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('disables Apply with a visible reason when the model is no longer in the catalogue', () => {
    renderWithProviders(
      <SuggestionsPanel
        suggestions={[makeSuggestion({ modelRef: 'gone' })]}
        services={SERVICES}
        onApplyLoad={vi.fn()}
        onApplyUnload={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByRole('button', { name: /Apply/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('This model is no longer in the catalogue.')).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(
      <SuggestionsPanel suggestions={[makeSuggestion()]} services={SERVICES} onApplyLoad={vi.fn()} onApplyUnload={vi.fn()} now={NOW} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
