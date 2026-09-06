/**
 * `CreateDefinitionForm` — TASK-890 black-box J4-F7.
 *
 * `Palette key *` was a free-text box over a CODE-OWNED set: a typo minted a definition targeting
 * a palette that does not exist, and the form never said which ones do. It is a picker over the
 * registry's own palette keys now — with the free-text box surviving as the documented fallback
 * for a registry read that fails, so a broken catalogue read degrades authoring rather than
 * blocking it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CreateDefinitionForm } from '../create-definition-form';

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), back: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function node(type: string, paletteKey: string | null, deprecated = false) {
  return { type, implemented: true, classes: [], paletteKey, entitlementKey: null, configSchema: null, inputs: [], outputs: [], deprecated };
}

/** Registry read + the create POST; returns the recorded calls. */
function installFetchMock(registry: { ok: boolean }) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('workflow-nodes')) {
        if (!registry.ok) return new Response('boom', { status: 500 });
        return Response.json({
          registryChecksum: 'chk',
          nodes: [node('core.agent', 'core'), node('summarize', 'summarization'), node('core.start', null)],
        });
      }
      return Response.json({ id: 'def-1' }, { status: 201 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe('CreateDefinitionForm', () => {
  it('offers the registry`s palette keys as a picker and posts the chosen one', async () => {
    const calls = installFetchMock({ ok: true });
    renderWithProviders(<CreateDefinitionForm />);

    const trigger = await screen.findByRole('combobox', { name: /palette key/i });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('option', { name: /summarization/i })).toBeTruthy();
    // `core` is the one authoring vocabulary and leads the list.
    expect(screen.getAllByRole('option')[0]?.getAttribute('data-value')).toBe('core');
    fireEvent.click(screen.getByRole('option', { name: /summarization/i }));

    fireEvent.change(screen.getByLabelText('Slug *'), { target: { value: 'discharge_summary' } });
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Discharge Summary' } });
    fireEvent.click(screen.getByRole('button', { name: /create draft/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect((calls.find((call) => call.method === 'POST')?.body as { paletteKey: string }).paletteKey).toBe('summarization');
  });

  it('falls back to the free-text box when the registry read fails — a broken catalogue never blocks authoring', async () => {
    installFetchMock({ ok: false });
    renderWithProviders(<CreateDefinitionForm />);

    expect(await screen.findByLabelText('Palette key *')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /palette key/i })).toBeNull();
  });
});
