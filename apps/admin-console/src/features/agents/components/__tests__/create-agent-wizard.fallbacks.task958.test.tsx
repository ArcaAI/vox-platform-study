/**
 * TASK-958 (36) — the wizard's FALLBACK list, rendered.
 *
 * `fallbackModelOptionLabel` is unit-tested beside the picker; this is the case
 * that proves the wizard actually calls it. The failure it guards is specific:
 * two connections of one vendor declaring the same wire model produce two
 * catalogue rows with the SAME name, so a fallback list that shows names only
 * offers the author "GPT-5.4 mini" twice — and the whole point of that fallback
 * is that it is a different key.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CreateAgentWizard } from '../create-agent-wizard';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
});

const CATALOGUE = {
  providers: [
    {
      id: 'byo:llm:openai',
      group: 'byo',
      name: 'OpenAI',
      providerClass: 'cloud-byo',
      connectionId: 'conn-1',
      connectionSlug: 'openai',
      connectionName: 'Production account',
      isDefault: true,
      usable: true,
      reason: null,
      modelCount: 1,
    },
    {
      id: 'byo:llm:openai-research',
      group: 'byo',
      name: 'OpenAI',
      providerClass: 'cloud-byo',
      connectionId: 'conn-2',
      connectionSlug: 'openai-research',
      connectionName: 'Research account',
      isDefault: false,
      usable: true,
      reason: null,
      modelCount: 1,
    },
    { id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 1 },
  ],
  models: [
    {
      id: 'm-prod',
      slug: 'openai-gpt-5-4-mini',
      name: 'GPT-5.4 mini',
      taskType: 'TEXT_GENERATION',
      providerId: 'byo:llm:openai',
      provider: 'openai',
      providerClass: 'cloud-byo',
      readiness: 'ready',
      readinessCheckedAt: null,
      readinessDetail: null,
      usable: true,
      unusableReason: null,
    },
    {
      id: 'm-research',
      slug: 'openai-research-gpt-5-4-mini',
      name: 'GPT-5.4 mini',
      taskType: 'TEXT_GENERATION',
      providerId: 'byo:llm:openai-research',
      provider: 'openai',
      providerClass: 'cloud-byo',
      readiness: 'ready',
      readinessCheckedAt: null,
      readinessDetail: null,
      usable: true,
      unusableReason: null,
    },
    {
      id: 'm-hope',
      slug: 'lms-gemma',
      name: 'Gemma 4 E2B',
      taskType: 'TEXT_GENERATION',
      providerId: 'hope',
      provider: 'lm-studio',
      providerClass: 'engine-served',
      readiness: 'ready',
      readinessCheckedAt: null,
      readinessDetail: null,
      usable: true,
      unusableReason: null,
    },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split('?')[0]!;
      if (path.includes('/admin/ai-models/catalogue')) return Response.json(CATALOGUE);
      // Everything else the wizard's Task step warms (the context-schema
      // catalog) answers an empty LIST — this case is about one <Select>'s
      // labels, and a catalog hook that got an envelope here would throw.
      return Response.json([]);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateAgentWizard — the fallback list names the connection (36)', () => {
  it('renders "‹model› · ‹connection›" for BYO models and the plain name for a Hope model', async () => {
    stubFetch();
    renderWithProviders(<CreateAgentWizard open onOpenChange={() => {}} onCreated={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/^Name \*/), { target: { value: 'Discharge summary' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    });

    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Fallback models (in order)'));
    });

    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toContain('GPT-5.4 mini · Production account');
    expect(options).toContain('GPT-5.4 mini · Research account');
    expect(options).toContain('Gemma 4 E2B');
  });
});
