/**
 * TASK-952 D-5 — the catalogue's `usable: false` machine reason codes rendered as short,
 * actionable guidance instead of the raw code. `reasonGuidance` is exercised directly for
 * the known-code mapping and the unknown-code fallback; `ModelPicker` is rendered to prove
 * the mapping is actually wired into the Provider/Model selects, that a usable entry still
 * carries no trailing reason segment at all, and that the ` (BYO)` / ` · <readiness>` prefix
 * segments survive untouched alongside the new guidance text.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ModelPicker, reasonGuidance } from '../model-picker';

const CATALOGUE = {
  providers: [
    { id: 'byo:stt:sarvam', group: 'byo', name: 'Sarvam', providerClass: 'cloud-byo', connectionId: null, usable: false, reason: 'no-enabled-connection', modelCount: 1 },
    { id: 'byo:stt:openai', group: 'byo', name: 'OpenAI', providerClass: 'cloud-byo', connectionId: 'conn-2', usable: false, reason: 'credential-missing', modelCount: 1 },
    { id: 'byo:stt:azure', group: 'byo', name: 'Azure', providerClass: 'cloud-byo', connectionId: 'conn-3', usable: true, reason: null, modelCount: 1 },
    // 'no-usable-model' is a real code the service emits for the Hope group summary
    // (aiModel.service.ts:824) but is deliberately NOT in the D-5 guidance map — it
    // must fall through verbatim, proving the fallback is wired end to end.
    { id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: false, reason: 'no-usable-model', modelCount: 1 },
  ],
  models: [
    {
      id: 'm-sarvam', slug: 'saaras', name: 'Saaras v4', taskType: 'SPEECH_TO_TEXT', providerId: 'byo:stt:sarvam', provider: 'sarvam',
      providerClass: 'cloud-byo', readiness: 'unknown', readinessCheckedAt: null, readinessDetail: null, usable: false, unusableReason: 'no-enabled-connection',
    },
    {
      id: 'm-azure', slug: 'azure-stt', name: 'Azure STT', taskType: 'SPEECH_TO_TEXT', providerId: 'byo:stt:azure', provider: 'azure',
      providerClass: 'cloud-byo', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null,
    },
    {
      id: 'm-hope', slug: 'lms-model', name: 'Local Model', taskType: 'SPEECH_TO_TEXT', providerId: 'hope', provider: 'lm-studio',
      providerClass: 'engine-served', readiness: 'engine_down', readinessCheckedAt: null, readinessDetail: null, usable: false, unusableReason: 'connection-resolver-unavailable',
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
  return <ModelPicker task="SPEECH_TO_TEXT" value={value} onChange={setValue} />;
}

beforeEach(() => stubCatalogue());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('reasonGuidance', () => {
  it('maps no-enabled-connection and credential-missing to the same two-step fix', () => {
    expect(reasonGuidance('no-enabled-connection')).toBe('enable it with a credential on AI Providers');
    expect(reasonGuidance('credential-missing')).toBe('enable it with a credential on AI Providers');
  });

  it('maps weights-not-available', () => {
    expect(reasonGuidance('weights-not-available')).toBe('model weights are not available yet');
  });

  it('maps connection-resolver-unavailable', () => {
    expect(reasonGuidance('connection-resolver-unavailable')).toBe('provider connections are unavailable right now');
  });

  it('maps platform-credential-not-entitled', () => {
    expect(reasonGuidance('platform-credential-not-entitled')).toBe('not included in your plan — add your own credential');
  });

  it('falls through an unknown code verbatim, never a generic "unavailable"', () => {
    expect(reasonGuidance('some-future-code')).toBe('some-future-code');
    expect(reasonGuidance('no-usable-model')).toBe('no-usable-model');
  });
});

describe('ModelPicker reason guidance (rendered)', () => {
  it('renders mapped guidance for known reason codes, with the (BYO) marker intact', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Sarvam (BYO) — enable it with a credential on AI Providers',
      'OpenAI (BYO) — enable it with a credential on AI Providers',
      'Azure (BYO)',
      'Hope provider — no-usable-model',
    ]);
  });

  it('renders a usable provider with no trailing reason segment at all', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    expect(await screen.findByRole('option', { name: 'Azure (BYO)' })).toBeTruthy();
  });

  it('renders mapped guidance for an unusable model, scoped to the default (first) provider', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Model'));
    expect(await screen.findByRole('option', { name: 'Saaras v4 — enable it with a credential on AI Providers' })).toBeTruthy();
  });

  it('keeps the readiness segment alongside the mapped reason once a non-BYO provider is chosen', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    fireEvent.click(await screen.findByRole('option', { name: /Hope provider/ }));
    fireEvent.click(await screen.findByLabelText('Model'));
    expect(await screen.findByRole('option', { name: 'Local Model · Engine down — provider connections are unavailable right now' })).toBeTruthy();
  });

  it('renders a usable model with no trailing segment at all once its provider is chosen', async () => {
    renderWithProviders(<Host />);
    fireEvent.click(await screen.findByLabelText('Provider'));
    fireEvent.click(await screen.findByRole('option', { name: 'Azure (BYO)' }));
    fireEvent.click(await screen.findByLabelText('Model'));
    expect(await screen.findByRole('option', { name: 'Azure STT' })).toBeTruthy();
  });
});
