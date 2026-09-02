/**
 * LLM Playground NER tab. fetch is stubbed at the network
 * boundary; covers the idle prompt, the extract flow (POST to the text-analyses
 * proxy), the entity list, and the empty result.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { NerTab } from '../ner-tab';

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

describe('NerTab', () => {
  it('shows the idle prompt before any run', () => {
    stubFetch({ entities: [], model_version: 'v1' });
    renderWithProviders(<NerTab />);
    expect(screen.getByText(/run an extraction to see the detected entities/i)).toBeDefined();
    expect((screen.getByRole('button', { name: /extract/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('extracts entities and renders them with type + confidence', async () => {
    const calls = stubFetch({
      entities: [
        { id: 'e1', text: 'aspirin', entity_type: 'DRUG', confidence: 0.99 },
        { id: 'e2', text: 'headache', entity_type: 'SYMPTOM', confidence: 0.88 },
      ],
      model_version: 'ner-2.1',
    });
    renderWithProviders(<NerTab />);

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Prescribed aspirin for a headache.' } });
    fireEvent.click(screen.getByRole('button', { name: /extract/i }));

    expect(await screen.findByText('aspirin')).toBeDefined();
    expect(screen.getByText('DRUG')).toBeDefined();
    expect(screen.getByText('SYMPTOM')).toBeDefined();
    expect(screen.getByText(/99%/)).toBeDefined();
    expect(screen.getByText(/model ner-2.1/i)).toBeDefined();

    await waitFor(() => {
      const call = calls.find((c) => c.url === '/api/hope/text-analyses/entities');
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({ text: 'Prescribed aspirin for a headache.' });
    });
  });

  it('renders the empty state when no entities are found', async () => {
    stubFetch({ entities: [], model_version: 'v1' });
    renderWithProviders(<NerTab />);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'nothing clinical here' } });
    fireEvent.click(screen.getByRole('button', { name: /extract/i }));
    expect(await screen.findByText(/no entities found/i)).toBeDefined();
  });
});
