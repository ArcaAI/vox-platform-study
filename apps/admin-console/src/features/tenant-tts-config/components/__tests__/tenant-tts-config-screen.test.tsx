/**
 * TASK-504 Phase 4 — TTS Configuration screen tests: effective resolve + OCC
 * row editor render, the If-Match save with expectedVersion, the 412 reload-merge
 * alert, and the write-only BYO credentials tab — against a URL-branching fetch
 * stub covering the BFF session route.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { EffectiveTtsConfig, TtsConfigRow, TtsCredential, TtsPlatformCatalog } from '../../api/types';
import { TenantTtsConfigScreen } from '../tenant-tts-config-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(option);
}

/** TASK-506 registry-derived platform catalog (providers + voices). */
const CATALOG: TtsPlatformCatalog = {
  providers: [
    {
      provider: 'azure',
      slug: 'azure-neural-voices',
      name: 'Azure neural voices',
      voices: [
        { id: 'en-IN-NeerjaNeural', locale: 'en-IN', gender: 'female' },
        { id: 'en-IN-PrabhatNeural', locale: 'en-IN', gender: 'male' },
        { id: 'ml-IN-SobhanaNeural', locale: 'ml-IN', gender: 'female' },
        { id: 'ml-IN-MidhunNeural', locale: 'ml-IN', gender: 'male' },
      ],
    },
    {
      provider: 'kokoro',
      slug: 'kokoro',
      name: 'Kokoro',
      voices: [
        { id: 'af_heart', locale: 'en-US' },
        { id: 'am_adam', locale: 'en-US' },
      ],
    },
    {
      provider: 'sarvam',
      slug: 'sarvam-bulbul',
      name: 'Sarvam Bulbul',
      voices: [
        { id: 'ishita', locale: 'ml-IN' },
        { id: 'shubh', locale: 'ml-IN' },
      ],
    },
  ],
};

function effective(overrides: Partial<EffectiveTtsConfig> = {}): EffectiveTtsConfig {
  return {
    tenantId: 'tnt-1',
    routingEn: ['azure'],
    routingMl: ['azure', 'indic_parler'],
    allowedProviders: ['azure', 'indic_parler'],
    defaultVoiceEn: 'en-US-JennyNeural',
    defaultVoiceMl: null,
    defaultFormat: 'pcm',
    defaultSpeed: 1,
    sampleRate: 24000,
    maxInputChars: 4096,
    sarvamPublicApiAllowed: false,
    voiceBindings: { 'en-female-1': { azure: 'en-IN-NeerjaNeural', kokoro: 'af_heart' } },
    ...overrides,
  };
}

function row(overrides: Partial<TtsConfigRow> = {}): TtsConfigRow {
  return {
    tenantId: 'tnt-1',
    defaultVoiceEn: 'en-US-JennyNeural',
    defaultVoiceMl: null,
    routingEn: ['azure'],
    routingMl: ['azure', 'indic_parler'],
    allowedProviders: ['azure', 'indic_parler'],
    defaultFormat: 'pcm',
    defaultSpeed: 1,
    sampleRate: 24000,
    maxInputChars: 4096,
    sarvamPublicApiAllowed: false,
    version: 7,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const CREDENTIALS: TtsCredential[] = [
  { provider: 'azure', endpoint: 'eastus', enabled: true, hasKey: true, keyVersion: 1 },
  { provider: 'sarvam', endpoint: null, enabled: false, hasKey: false },
];

const SESSION = {
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1', departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: 'tnt-1' as string | null,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof SESSION;
  configRow?: TtsConfigRow;
  credentials?: TtsCredential[];
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, configRow = row(), credentials = CREDENTIALS, custom }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url === '/api/auth/session') return Response.json(session);
      if (call.method === 'GET' && call.url === '/api/hope/admin/tts-config') {
        return Response.json(effective());
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/tts-config/row') {
        return Response.json(configRow, { headers: configRow.version > 0 ? { etag: `"${configRow.version}"` } : {} });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/tts-config/credentials') {
        return Response.json(credentials);
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/tts-config/catalog') {
        return Response.json(CATALOG);
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TenantTtsConfigScreen', () => {
  it('renders the effective resolve card and the OCC editor from the stub', async () => {
    stubFetch();
    renderWithProviders(<TenantTtsConfigScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'TTS Configuration' })).toBeDefined();
    expect(await screen.findByText('Effective TTS config')).toBeDefined();
    expect(screen.getByLabelText('Sample rate (Hz)')).toBeDefined();
    expect(screen.getByRole('button', { name: /Save · If-Match/ })).toBeDefined();
  });

  it('saves a sparse patch with If-Match and expectedVersion from the read ETag', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/tts-config/row') {
          return Response.json(row({ sampleRate: 16000, version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />);
    const sampleRate = await screen.findByLabelText('Sample rate (Hz)');

    fireEvent.change(sampleRate, { target: { value: '16000' } });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/hope/admin/tts-config/row');
    expect(put?.headers.get('if-match')).toBe('"7"');
    expect(put?.body).toEqual({ sampleRate: 16000, expectedVersion: 7 });
  });

  it('shows the OCC conflict alert with reload-merge when the PUT returns 412', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />);

    fireEvent.change(await screen.findByLabelText('Max input chars'), { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    // Local edits are kept for the reload-merge.
    expect((screen.getByLabelText('Max input chars') as HTMLInputElement).value).toBe('2048');
  });

  it('renders the BYO credentials tab masked and rotates a key write-only', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/tts-config/credentials/azure') {
          return Response.json({ provider: 'azure', endpoint: 'eastus', enabled: true, hasKey: true, keyVersion: 2 });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />, { searchParams: '?tab=credentials' });

    // Masked: the configured badge appears, never a key value.
    expect(await screen.findByText(/configured · v1/)).toBeDefined();
    const keyInput = screen.getByLabelText('API key (enter to rotate)') as HTMLInputElement;
    expect(keyInput.type).toBe('password');

    fireEvent.change(keyInput, { target: { value: 'new-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: /Rotate key/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/hope/admin/tts-config/credentials/azure');
    expect(put?.body).toEqual({ apiKey: 'new-secret-key', endpoint: 'eastus', enabled: true });
  });

  it('renders the internal-id voice selects and the catalog-driven bindings editor (TASK-506)', async () => {
    stubFetch({ configRow: row({ defaultVoiceEn: 'en-female-1' }) });
    renderWithProviders(<TenantTtsConfigScreen />);

    // Standard internal id -> closed Select over the internal voice ids.
    const voiceEn = await screen.findByLabelText('Default English voice');
    expect(voiceEn.getAttribute('role')).toBe('combobox');

    // Bindings editor: one row per internal voice id, one select per catalog provider.
    expect(screen.getByText('Voice bindings')).toBeDefined();
    for (const voiceId of ['en-female-1', 'en-male-1', 'ml-female-1', 'ml-male-1']) {
      expect(screen.getAllByText(voiceId).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('combobox', { name: 'sarvam voice for ml-female-1' })).toBeDefined();

    // Effective merged bindings are read-only on the resolve card.
    expect(screen.getByText('bind en-female-1')).toBeDefined();
    expect(screen.getByText('azure:en-IN-NeerjaNeural, kokoro:af_heart')).toBeDefined();
  });

  it('keeps the free-text escape hatch when the saved voice id is nonstandard', async () => {
    stubFetch(); // row() ships the nonstandard 'en-US-JennyNeural'
    renderWithProviders(<TenantTtsConfigScreen />);

    const voiceEn = await screen.findByLabelText('Default English voice');
    expect(voiceEn.tagName).toBe('INPUT');
    expect((voiceEn as HTMLInputElement).value).toBe('en-US-JennyNeural');
  });

  it('saves an internal default voice picked from the select', async () => {
    const calls = stubFetch({
      configRow: row({ defaultVoiceEn: 'en-female-1' }),
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/tts-config/row') {
          return Response.json(row({ defaultVoiceEn: 'en-male-1', version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />);

    await selectOption(await screen.findByLabelText('Default English voice'), 'en-male-1');
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ defaultVoiceEn: 'en-male-1', expectedVersion: 7 });
  });

  it('saves a changed voice binding as the full merged voiceBindings map', async () => {
    const calls = stubFetch({
      configRow: row({ configJson: { voiceBindings: { 'ml-female-1': { azure: 'ml-IN-SobhanaNeural' } } } }),
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/tts-config/row') {
          return Response.json(row({ version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />);

    await selectOption(await screen.findByRole('combobox', { name: 'sarvam voice for ml-female-1' }), /^ishita/);
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({
      voiceBindings: { 'ml-female-1': { azure: 'ml-IN-SobhanaNeural', sarvam: 'ishita' } },
      expectedVersion: 7,
    });
  });

  it('surfaces a block error with retry when the effective read fails', async () => {
    let attempts = 0;
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/tts-config') {
          attempts += 1;
          if (attempts === 1) return Response.json({ message: 'tts unavailable' }, { status: 503 });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantTtsConfigScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('tts unavailable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Effective TTS config')).toBeDefined();
  });
});
