/**
 * TASK-958 D-5/D-10 — the picker names the CONNECTION, not just the vendor.
 *
 * With two OpenAI accounts on one tenant the old label ("OpenAI (BYO)") was the
 * same string twice: an author choosing a provider could not tell which key the
 * agent would spend, and the catalogue id (`byo:llm:<connectionSlug>`) was the
 * only thing that differed. These cases pin:
 *
 *   (35) one provider entry PER CONNECTION, labelled by the server's provider
 *        name plus the connection's own name (or slug), with the default marked;
 *   (36) the fallback option label carries the connection for a BYO model and
 *        NOT for a Hope one — a platform model has no tenant connection to name;
 *   (38) 0 axe violations on the picker as the agent wizard renders it.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { CatalogueModel, CatalogueProvider } from '@/shared/catalog';
import { ModelPicker, fallbackModelOptionLabel } from '../model-picker';

/** Two OpenAI CONNECTIONS of one tenant, plus the single Hope provider. */
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
    {
      id: 'hope',
      group: 'hope',
      name: 'Hope provider',
      providerClass: null,
      connectionId: null,
      connectionSlug: null,
      connectionName: null,
      isDefault: null,
      usable: true,
      reason: null,
      modelCount: 1,
    },
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

function stubCatalogue(body: unknown = CATALOGUE) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function Host({ value: initial = '' }: { value?: string }) {
  const [value, setValue] = useState(initial);
  return <ModelPicker task="TEXT_GENERATION" value={value} onChange={setValue} />;
}

beforeEach(() => stubCatalogue());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelPicker — one entry per connection (35)', () => {
  it('lists both OpenAI connections, named, with the default marked', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));

    const options = await screen.findAllByRole('option');
    const labels = options.map((option) => option.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('OpenAI (BYO)');
    expect(labels[0]).toContain('Production account');
    expect(labels[0]).toContain('Default');
    expect(labels[1]).toContain('Research account');
    expect(labels[1]).not.toContain('Default');
    // The Hope group names no connection — it has none.
    expect(labels[2]).toBe('Hope provider');
  });

  it('scopes the models to the CHOSEN connection, not to the vendor', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    fireEvent.click(await screen.findByRole('option', { name: /Research account/ }));

    fireEvent.click(await screen.findByLabelText('Model'));
    const models = await screen.findAllByRole('option');
    expect(models).toHaveLength(1);
    expect(models[0]!.textContent).toContain('GPT-5.4 mini');
  });
});

describe('fallbackModelOptionLabel — the fallback list names the connection (36)', () => {
  const providers = CATALOGUE.providers as unknown as CatalogueProvider[];
  const models = CATALOGUE.models as unknown as CatalogueModel[];

  it('appends the connection NAME to a BYO model', () => {
    expect(fallbackModelOptionLabel(models[1]!, providers)).toBe('GPT-5.4 mini · Research account');
  });

  it('falls back to the connection SLUG when the tenant named nothing', () => {
    const unnamed = providers.map((provider) => (provider.id === 'byo:llm:openai-research' ? { ...provider, connectionName: null } : provider));
    expect(fallbackModelOptionLabel(models[1]!, unnamed)).toBe('GPT-5.4 mini · openai-research');
  });

  it('leaves a Hope model as its plain name — a platform model names no tenant connection', () => {
    expect(fallbackModelOptionLabel(models[2]!, providers)).toBe('Gemma 4 E2B');
  });

  it('leaves a BYO model alone when the catalogue carries no connection slug (pre-merge payload)', () => {
    const legacy = providers.map((provider) =>
      provider.id === 'byo:llm:openai' ? { ...provider, connectionSlug: null, connectionName: null, isDefault: null } : provider,
    );
    expect(fallbackModelOptionLabel(models[0]!, legacy)).toBe('GPT-5.4 mini');
  });
});

describe('ModelPicker — accessibility (38)', () => {
  it('has no axe violations with connection-labelled providers', async () => {
    const { container } = renderWithProviders(<Host value="m-research" />);
    await waitFor(() => expect(screen.getAllByText('Ready').length).toBeGreaterThan(0));
    expect(await axe(container)).toHaveNoViolations();
  });
});
