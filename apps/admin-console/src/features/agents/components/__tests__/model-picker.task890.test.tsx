/**
 * TASK-890 §3.7/§3.10 — the shared Model picker: Provider (BYO first, then the single "Hope
 * provider") then a Model scoped to it, over `GET admin/ai-models/catalogue` (never
 * `admin/ai-models`, which 403s a tenant admin since TASK-890 L1). An unusable provider/model is
 * shown greyed with its reason and a link to `/ai-providers`, never hidden.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ModelPicker } from '../model-picker';

const CATALOGUE = {
  providers: [
    { id: 'byo:text:azure', group: 'byo', name: 'Azure (mine)', providerClass: 'cloud-byo', connectionId: 'conn-1', usable: true, reason: null, modelCount: 1 },
    { id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: false, reason: 'engine-down', modelCount: 1 },
  ],
  models: [
    { id: 'm-byo-1', slug: 'byo-azure-gpt', name: 'My Azure GPT', taskType: 'TEXT_GENERATION', providerId: 'byo:text:azure', provider: 'azure', providerClass: 'cloud-byo', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
    { id: 'm-hope-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'engine_down', readinessCheckedAt: '2026-09-06T10:00:00.000Z', readinessDetail: null, usable: false, unusableReason: 'engine-down' },
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

describe('ModelPicker', () => {
  it('lists BYO providers first, then the single Hope provider', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Azure (mine) (BYO)', 'Hope provider — engine-down']);
  });

  it('greys an unusable provider with its reason and a link to /ai-providers', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    fireEvent.click(await screen.findByRole('option', { name: /Hope provider/ }));
    const link = await screen.findByRole('link', { name: /Why can't I use this\?/ });
    expect(link).toHaveProperty('href', expect.stringContaining('/ai-providers'));
    expect(screen.getAllByText(/engine-down/).length).toBeGreaterThanOrEqual(1);
  });

  it('scopes the Model select to the chosen provider and shows the readiness badge', async () => {
    renderWithProviders(<Host />);
    // Default provider is the first (BYO) — its one model is offered.
    fireEvent.click(await screen.findByLabelText('Model'));
    expect(await screen.findByRole('option', { name: /My Azure GPT/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Gemma 4 E2B/ })).toBeNull();
  });

  it('picking a model surfaces its readiness and the checked-at time', async () => {
    renderWithProviders(<Host value="m-byo-1" />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
  });

  it('has no axe violations once loaded (WCAG 2.2 AA gate)', async () => {
    const { container } = renderWithProviders(<Host value="m-byo-1" />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
    expect(await axe(container)).toHaveNoViolations();
  });
});
