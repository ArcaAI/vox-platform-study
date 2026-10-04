/**
 * TASK-1036 C5 (W2, §8.6, OD-1, OD-16) — the simple agent settings: per-task switches, temperature
 * and max output tokens only when the model supports them, a read-only "Guardrails: always on"
 * row, and every platform-managed knob hidden from tenant admins (a super admin gets it behind a
 * collapsed "Platform tuning" section). fetch is stubbed at the network boundary.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { AgentSimpleParameters } from '../simple-parameters';

type Caps = { supportsTools: boolean; supportsVision: boolean; supportsAttachments: boolean; voices: string[]; supportedGenerationParams: string[]; reasoning?: boolean };
const BASE: Caps = { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] };

function model(id: string, taskType: string, capabilities: Caps) {
  return {
    id, slug: id, name: id, description: null, taskType, providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served',
    readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null, capabilities,
  };
}

function stub({ models, elevated = false, templates = [] as unknown[] }: { models: unknown[]; elevated?: boolean; templates?: unknown[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('auth/session')) return Response.json({ user: { id: 'u', roles: [] }, effectiveIsElevated: elevated, isElevated: elevated });
      if (url.includes('ai-models/catalogue')) return Response.json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, usable: true, reason: null, modelCount: models.length }], models });
      if (url.includes('document-templates')) return Response.json(templates);
      return Response.json([]);
    }),
  );
}

type Task = 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH';
function Host({ task, modelId, initial = {}, onChange, extra }: { task: Task; modelId: string; initial?: Record<string, unknown>; onChange?: (next: Record<string, unknown>) => void; extra?: Record<string, unknown> }) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  const [slug, setSlug] = useState<string | null>(null);
  return (
    <AgentSimpleParameters
      task={task}
      modelId={modelId}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      documentTemplateSlug={slug}
      onDocumentTemplateChange={setSlug}
      {...extra}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentSimpleParameters — text generation', () => {
  it('offers temperature, max output tokens, DNA and structured output; hides every platform-managed knob', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)] });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    expect(await screen.findByLabelText('Temperature')).toBeTruthy();
    expect(screen.getByLabelText('Max output tokens')).toBeTruthy();
    expect(screen.getByLabelText(/DNA writing style/i)).toBeTruthy();
    expect(screen.getByLabelText('Structured output')).toBeTruthy();
    for (const hidden of ['Top P', 'Top K', 'Frequency Penalty', 'Presence Penalty', 'Seed', 'Reasoning', 'Memory']) {
      expect(screen.queryByLabelText(hidden)).toBeNull();
    }
    expect(screen.queryByText('Platform tuning')).toBeNull();
  });

  it('hides temperature for a reasoning model but keeps max output tokens', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', { ...BASE, reasoning: true })] });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    expect(await screen.findByLabelText('Max output tokens')).toBeTruthy();
    expect(screen.queryByLabelText('Temperature')).toBeNull();
  });

  it('hides both generation knobs when the model supports neither', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', { ...BASE, supportedGenerationParams: [] })] });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    expect(await screen.findByLabelText(/DNA writing style/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('Temperature')).toBeNull());
    expect(screen.queryByLabelText('Max output tokens')).toBeNull();
  });

  it('writes temperature into parameters.generation and clears the key when emptied', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)] });
    const onChange = vi.fn();
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" onChange={onChange} />);
    const temperature = await screen.findByLabelText('Temperature');
    fireEvent.change(temperature, { target: { value: '0.3' } });
    expect(onChange).toHaveBeenLastCalledWith({ generation: { temperature: 0.3 } });
    fireEvent.change(temperature, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('the DNA switch writes an explicit boolean at parameters.dna.enabled', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)] });
    const onChange = vi.fn();
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText(/DNA writing style/i));
    expect(onChange).toHaveBeenLastCalledWith({ dna: { enabled: true } });
  });

  it('offers only servable document templates, always the latest version', async () => {
    stub({
      models: [model('m1', 'TEXT_GENERATION', BASE)],
      templates: [
        { id: 't1', name: 'SOAP', slug: 'soap', status: 'APPROVED', pinnedVersionNumber: 2, isDefault: true },
        { id: 't2', name: 'Draft only', slug: 'draft-only', status: 'DRAFT', pinnedVersionNumber: null, isDefault: false },
      ],
    });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    fireEvent.click(await screen.findByLabelText('Document template'));
    expect(await screen.findByRole('option', { name: /SOAP/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Draft only/ })).toBeNull();
    expect(screen.getByText(/always uses the latest approved version/i)).toBeTruthy();
  });

  it('shows a read-only "Guardrails: always on" row (OD-1)', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)] });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    const row = await screen.findByText(/Guardrails: always on/i);
    expect(row.closest('[data-slot], div')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /guardrails/i })).toBeNull();
  });
});

describe('AgentSimpleParameters — platform tuning', () => {
  it('a tenant admin never sees the section; a super admin sees it collapsed', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)], elevated: false });
    const tenant = renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    await screen.findByLabelText('Temperature');
    expect(screen.queryByText('Platform tuning')).toBeNull();
    tenant.unmount();

    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)], elevated: true });
    renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    const summary = await screen.findByText('Platform tuning');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(await within(details).findByLabelText('Top P')).toBeTruthy();
  });
});

describe('AgentSimpleParameters — speech to text', () => {
  it('offers VAD, noise suppression and diarization switches with an enrollment hint linking to voice profiles', async () => {
    stub({ models: [model('asr', 'AUTOMATIC_SPEECH_RECOGNITION', BASE)] });
    const onChange = vi.fn();
    renderWithProviders(<Host task="SPEECH_TO_TEXT" modelId="asr" onChange={onChange} />);
    expect(await screen.findByLabelText('Voice activity detection')).toBeTruthy();
    expect(screen.getByLabelText('Noise suppression')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Speaker separation/i));
    expect(onChange).toHaveBeenLastCalledWith({ audioFrontEnd: { diarization: { enabled: true } } });
    const hint = screen.getByText(/enrolled voice profiles/i);
    expect(hint.closest('div')?.querySelector('a')?.getAttribute('href')).toBe('/playground/voice-profiles');
    expect(screen.queryByLabelText('Temperature')).toBeNull();
    expect(screen.queryByLabelText('Beam Size')).toBeNull();
  });
});

describe('AgentSimpleParameters — text to speech', () => {
  it('offers a voice picker from the model\'s capabilities and a speed', async () => {
    stub({ models: [model('tts', 'TEXT_TO_SPEECH', { ...BASE, voices: ['ava', 'kai'], supportedGenerationParams: [] })] });
    const onChange = vi.fn();
    renderWithProviders(<Host task="TEXT_TO_SPEECH" modelId="tts" onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Voice'));
    fireEvent.click(await screen.findByRole('option', { name: 'kai' }));
    expect(onChange).toHaveBeenLastCalledWith({ voice: 'kai' });
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1.25' } });
    expect(onChange).toHaveBeenLastCalledWith({ voice: 'kai', speed: 1.25 });
  });

  it('hides the voice picker when the model lists no voices', async () => {
    stub({ models: [model('tts', 'TEXT_TO_SPEECH', { ...BASE, voices: [] })] });
    renderWithProviders(<Host task="TEXT_TO_SPEECH" modelId="tts" />);
    expect(await screen.findByLabelText('Speed')).toBeTruthy();
    expect(screen.queryByLabelText('Voice')).toBeNull();
  });
});

describe('AgentSimpleParameters — accessibility', () => {
  it('has no axe violations', async () => {
    stub({ models: [model('m1', 'TEXT_GENERATION', BASE)], elevated: true });
    const { container } = renderWithProviders(<Host task="TEXT_GENERATION" modelId="m1" />);
    await screen.findByLabelText('Temperature');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AgentSimpleParameters — E4b', () => {
  it('opens the "Enroll voices" link in a new tab and says so to assistive tech', async () => {
    stub({ models: [model('asr', 'AUTOMATIC_SPEECH_RECOGNITION', BASE)] });
    renderWithProviders(<Host task="SPEECH_TO_TEXT" modelId="asr" />);
    const link = await screen.findByRole('link', { name: /enroll voices/i });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.textContent).toMatch(/opens in a new tab/i);
  });

  it('shows a Skeleton, never "Loading…" text, while the document templates load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('document-templates')) return new Promise<Response>(() => undefined);
        if (url.includes('auth/session')) return Response.json({ user: { id: 'u', roles: [] }, effectiveIsElevated: false, isElevated: false });
        if (url.includes('ai-models/catalogue')) return Response.json({ providers: [], models: [model('m', 'TEXT_GENERATION', BASE)] });
        return Response.json([]);
      }),
    );
    const { container } = renderWithProviders(<Host task="TEXT_GENERATION" modelId="m" />);
    await screen.findByText('Document template');
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });
});
