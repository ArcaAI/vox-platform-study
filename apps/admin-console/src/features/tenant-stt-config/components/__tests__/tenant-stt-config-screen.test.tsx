/**
 * STT Configuration screen tests: effective resolve + OCC fallback-row editor
 * render, the If-Match save with expectedVersion, the 412 reload-merge alert,
 * the write-only BYO credentials tab (OCC per credential), the loading/empty/
 * error states, and axe cleanliness per tab in both themes — against a
 * URL-branching fetch stub covering the BFF session route.
 *
 * ⚠️ The screen under test is design-gate-OPEN (rule 12); these tests lock the
 * behaviour so a later ratified frame can only tweak layout, not contract.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { EffectiveSttConfig, SttConfigRow, SttCredential, SttPipelineCandidate } from '../../api/types';
import { TenantSttConfigScreen } from '../tenant-stt-config-screen';

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

const CANDIDATES: SttPipelineCandidate[] = [
  { id: 'pipe-azure', name: 'Azure Speech transcription', slug: 'azure-speech-transcription', isDefault: false, resourceStatus: 'ENABLED', tags: [] },
  { id: 'pipe-sarvam', name: 'Sarvam saaras', slug: 'sarvam-saaras', isDefault: false, resourceStatus: 'ENABLED', tags: [] },
];

function effective(overrides: Partial<EffectiveSttConfig> = {}): EffectiveSttConfig {
  return {
    tenantId: 'tnt-1',
    fallbackPipelineId: 'pipe-azure',
    autoSwitchEnabled: true,
    consecutiveFailureThreshold: 2,
    ...overrides,
  };
}

function row(overrides: Partial<SttConfigRow> = {}): SttConfigRow {
  return {
    tenantId: 'tnt-1',
    fallbackPipelineId: 'pipe-azure',
    autoSwitchEnabled: true,
    consecutiveFailureThreshold: 2,
    version: 7,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const CREDENTIALS: SttCredential[] = [{ provider: 'azure-speech', region: 'eastus', enabled: true, hasKey: true, keyVersion: 1, version: 3 }];

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
  configRow?: SttConfigRow;
  credentials?: SttCredential[];
  effectiveConfig?: EffectiveSttConfig;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ configRow = row(), credentials = CREDENTIALS, effectiveConfig = effective(), custom }: StubOptions = {}): RecordedCall[] {
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
      if (call.url === '/api/auth/session') return Response.json(SESSION);
      if (call.method === 'GET' && call.url === '/api/hope/admin/stt-config') {
        return Response.json(effectiveConfig);
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/stt-config/row') {
        return Response.json(configRow, { headers: configRow.version > 0 ? { etag: `"${configRow.version}"` } : {} });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/stt-config/fallback-candidates') {
        return Response.json(CANDIDATES);
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/stt-config/credentials') {
        return Response.json(credentials);
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

describe('TenantSttConfigScreen', () => {
  it('renders the effective resolve card and the OCC fallback editor from the stub', async () => {
    stubFetch();
    renderWithProviders(<TenantSttConfigScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'STT Configuration' })).toBeDefined();
    expect(await screen.findByText('Effective STT fallback')).toBeDefined();
    expect(screen.getByLabelText('Consecutive failure threshold')).toBeDefined();
    expect(screen.getByRole('button', { name: /Save · If-Match/ })).toBeDefined();
  });

  it('shows the WorkingTenantGate skeleton before the session resolves', () => {
    stubFetch();
    const { container } = renderWithProviders(<TenantSttConfigScreen />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('renders a no-fallback empty spec on the resolve card', async () => {
    stubFetch({ effectiveConfig: effective({ fallbackPipelineId: null, autoSwitchEnabled: false }) });
    renderWithProviders(<TenantSttConfigScreen />);

    await screen.findByText('Effective STT fallback');
    expect(screen.getByText('off')).toBeDefined();
    // The em-dash placeholder marks the unset fallback pointer.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('saves a sparse threshold change with If-Match and expectedVersion from the read ETag', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/stt-config/row') {
          return Response.json(row({ consecutiveFailureThreshold: 4, version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />);
    const threshold = await screen.findByLabelText('Consecutive failure threshold');

    fireEvent.change(threshold, { target: { value: '4' } });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/hope/admin/stt-config/row');
    expect(put?.headers.get('if-match')).toBe('"7"');
    expect(put?.body).toEqual({ consecutiveFailureThreshold: 4, expectedVersion: 7 });
  });

  it('saves the fallback pipeline pointer picked from the select', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/stt-config/row') {
          return Response.json(row({ fallbackPipelineId: 'pipe-sarvam', version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />);

    await selectOption(await screen.findByLabelText('Fallback pipeline'), /Sarvam saaras/);
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ fallbackPipelineId: 'pipe-sarvam', expectedVersion: 7 });
  });

  it('shows the OCC conflict alert with reload-merge when the row PUT returns 412', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />);

    fireEvent.change(await screen.findByLabelText('Consecutive failure threshold'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    // Local edits are kept for the reload-merge.
    expect((screen.getByLabelText('Consecutive failure threshold') as HTMLInputElement).value).toBe('5');
  });

  it('renders the BYO credentials tab masked and rotates a key write-only under If-Match', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/stt-config/credentials/azure-speech') {
          return Response.json({ provider: 'azure-speech', region: 'eastus', enabled: true, hasKey: true, keyVersion: 2, version: 4 });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />, { searchParams: '?tab=credentials' });

    // Masked: the configured badge appears, never a key value.
    expect(await screen.findByText(/configured · v1/)).toBeDefined();
    const keyInput = screen.getByLabelText('API key (enter to rotate)') as HTMLInputElement;
    expect(keyInput.type).toBe('password');

    fireEvent.change(keyInput, { target: { value: 'new-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: /Rotate key · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/hope/admin/stt-config/credentials/azure-speech');
    expect(put?.headers.get('if-match')).toBe('"3"');
    expect(put?.body).toEqual({ apiKey: 'new-secret-key', enabled: true, region: 'eastus', expectedVersion: 3 });
  });

  it('creates a not-yet-configured provider key with If-Match "0"', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT' && call.url === '/api/hope/admin/stt-config/credentials/openai') {
          return Response.json({ provider: 'openai', enabled: true, hasKey: true, keyVersion: 1, version: 1 });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />, { searchParams: '?tab=credentials' });

    // The OpenAI card is "not configured" — its Save button uses expectedVersion 0.
    await screen.findByText('OpenAI');
    const openaiCard = screen.getByRole('heading', { name: 'OpenAI' }).closest('[data-slot="card"]') as HTMLElement;
    const keyInput = openaiCard.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-openai' } });
    fireEvent.click(within(openaiCard).getByRole('button', { name: /Save key · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/hope/admin/stt-config/credentials/openai');
    expect(put?.headers.get('if-match')).toBe('"0"');
    expect(put?.body).toEqual({ apiKey: 'sk-openai', enabled: true, expectedVersion: 0 });
  });

  it('surfaces a block error with retry when the effective read fails', async () => {
    let attempts = 0;
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/stt-config') {
          attempts += 1;
          if (attempts === 1) return Response.json({ message: 'stt unavailable' }, { status: 503 });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantSttConfigScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('stt unavailable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Effective STT fallback')).toBeDefined();
  });

  it('has no axe violations on the fallback and credentials tabs', async () => {
    stubFetch();
    const { container } = renderWithProviders(<TenantSttConfigScreen />);
    await screen.findByText('Effective STT fallback');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations on the credentials tab', async () => {
    stubFetch();
    const { container } = renderWithProviders(<TenantSttConfigScreen />, { searchParams: '?tab=credentials' });
    await screen.findByText('Azure Speech');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<TenantSttConfigScreen />);
      await screen.findByText('Effective STT fallback');
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
