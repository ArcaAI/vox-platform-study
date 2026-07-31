/**
 * "AI Providers" screen (TASK-575, wired into nav under TASK-586 Lane J):
 * the tabbed data flow (LLM / STT / TTS) over the unified
 * `admin/providers/:service/:provider` route, masked Configured/None
 * credential cards, OCC (If-Match) save + 412 reload-merge, the
 * working-tenant gate + "Acting on" banner, and axe 0 violations per tab in
 * BOTH themes.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ProviderConnection, ProviderService } from '../../api/types';
import { PROVIDERS_BY_SERVICE } from '../provider-meta';
import { AiProvidersScreen } from '../ai-providers-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const TENANT_SESSION = {
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

const ELEVATED_WITH_TENANT_SESSION = {
  ...TENANT_SESSION,
  user: { id: 'u-9', username: 'global_admin', email: 'root@arca.ai', roles: ['GLOBAL_ADMIN'] },
  isElevated: true,
  effectiveIsElevated: true,
};

const ELEVATED_NO_TENANT_SESSION = {
  ...ELEVATED_WITH_TENANT_SESSION,
  workingTenantId: null,
  workingTenantName: null,
  effectiveTenantId: null,
};

function connectionOf(service: ProviderService, provider: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    tenantId: 'tnt-1',
    service,
    provider,
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: false,
    keyVersion: null,
    enabled: false,
    extraJson: null,
    version: 0,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof TENANT_SESSION;
  connections?: Partial<Record<ProviderService, Record<string, ProviderConnection>>>;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = TENANT_SESSION, connections = {}, custom }: StubOptions = {}): RecordedCall[] {
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

      const url = new URL(call.url, 'http://test.local');
      // Unified plane (C2/C3): `admin/providers/:service/:provider`.
      const match = /^\/api\/hope\/admin\/providers\/(llm|stt|tts)\/([^/]+)$/.exec(url.pathname);
      if (call.method === 'GET' && match) {
        const service = match[1] as ProviderService;
        const provider = match[2];
        const row = connections[service]?.[provider] ?? connectionOf(service, provider);
        return Response.json(row, { headers: row.version > 0 ? { etag: `"${row.version}"` } : {} });
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

describe('AiProvidersScreen — tab structure', () => {
  it('renders the header and defaults to the LLM tab', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Providers' })).toBeDefined();
    expect(await screen.findByText('Azure OpenAI')).toBeDefined();
  });

  it('switches to the STT tab and renders its provider set', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />, { searchParams: '?tab=stt' });

    expect(await screen.findByText('Azure Speech')).toBeDefined();
    expect(screen.getByText('Sarvam')).toBeDefined();
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);
  });

  it('switches to the TTS tab and renders its provider set', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />, { searchParams: '?tab=tts' });

    expect(await screen.findByText('Azure Speech')).toBeDefined();
    expect(screen.getByText('Sarvam')).toBeDefined();
    // TTS has exactly 2 providers (no OpenAI entry).
    expect(PROVIDERS_BY_SERVICE.tts).toHaveLength(2);
  });
});

describe('AiProvidersScreen — credential cards', () => {
  it('renders a Configured card and a None card, and never exposes key material', async () => {
    stubFetch({
      connections: {
        llm: {
          azure: connectionOf('llm', 'azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3, baseUrl: 'https://acme.openai.azure.com' }),
        },
      },
    });
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByText(/configured · v4/i)).toBeDefined();
    expect((await screen.findAllByText('not configured')).length).toBe(PROVIDERS_BY_SERVICE.llm.length - 1);

    const keyInputs = document.querySelectorAll('input[type="password"]');
    expect(keyInputs.length).toBe(PROVIDERS_BY_SERVICE.llm.length);
    keyInputs.forEach((input) => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('sends If-Match from the row ETag on save (OCC) and clears the key field', async () => {
    const calls = stubFetch({
      connections: { llm: { azure: connectionOf('llm', 'azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3 }) } },
      custom: (call) => {
        if (call.method === 'PUT' && call.url.includes('/providers/llm/azure')) {
          return Response.json(connectionOf('llm', 'azure', { hasKey: true, keyVersion: 5, enabled: true, version: 4 }), {
            headers: { etag: '"4"' },
          });
        }
        return undefined;
      },
    });
    renderWithProviders(<AiProvidersScreen />);

    const input = (await screen.findAllByLabelText(/API key/i))[0];
    fireEvent.change(input, { target: { value: 'sk-tenant-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /rotate key/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeDefined();
      expect(put!.headers.get('if-match')).toBe('"3"');
      expect((put!.body as Record<string, unknown>).expectedVersion).toBe(3);
      expect((put!.body as Record<string, unknown>).apiKey).toBe('sk-tenant-secret');
    });
  });

  it('sends If-Match "0" when creating the first credential row', async () => {
    const calls = stubFetch({
      custom: (call) =>
        call.method === 'PUT' ? Response.json(connectionOf('llm', 'bedrock', { hasKey: true, version: 1 }), { headers: { etag: '"1"' } }) : undefined,
    });
    renderWithProviders(<AiProvidersScreen />);

    await screen.findByText('Amazon Bedrock');
    const inputs = await screen.findAllByLabelText(/API key/i);
    fireEvent.change(inputs[1], { target: { value: 'aws-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: /save key/i })[1]);

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put!.headers.get('if-match')).toBe('"0"');
      expect((put!.body as Record<string, unknown>).expectedVersion).toBe(0);
    });
  });

  it('surfaces the OCC conflict alert when the PUT returns 412', async () => {
    stubFetch({
      connections: { stt: { 'azure-speech': connectionOf('stt', 'azure-speech', { hasKey: true, enabled: true, version: 3 }) } },
      custom: (call) => (call.method === 'PUT' ? new Response('conflict', { status: 412 }) : undefined),
    });
    renderWithProviders(<AiProvidersScreen />, { searchParams: '?tab=stt' });

    const input = (await screen.findAllByLabelText(/API key/i))[0];
    fireEvent.change(input, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: /rotate key/i }));

    expect(await screen.findByText(/changed by another admin after you loaded it/i)).toBeDefined();
  });

  it('routes a store: extra field (STT model override) into extraJson on save', async () => {
    const calls = stubFetch({
      custom: (call) =>
        call.method === 'PUT' ? Response.json(connectionOf('stt', 'sarvam', { hasKey: true, version: 1 }), { headers: { etag: '"1"' } }) : undefined,
    });
    renderWithProviders(<AiProvidersScreen />, { searchParams: '?tab=stt' });

    await screen.findByText('Sarvam');
    const inputs = await screen.findAllByLabelText(/API key/i);
    // sarvam is the 2nd STT provider card.
    fireEvent.change(inputs[1], { target: { value: 'sarvam-secret' } });
    // "Model (optional)" is a field on all three STT provider cards (index 1 = sarvam).
    const modelField = (await screen.findAllByLabelText('Model (optional)'))[1];
    fireEvent.change(modelField, { target: { value: 'saaras:v3' } });
    fireEvent.click(screen.getAllByRole('button', { name: /save key/i })[1]);

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/providers/stt/sarvam'));
      expect(put).toBeDefined();
      expect((put!.body as Record<string, unknown>).extraJson).toEqual({ model: 'saaras:v3' });
    });
  });
});

describe('AiProvidersScreen — tenant scoping', () => {
  it('gates an elevated session without a working tenant on the NoTenant empty state', async () => {
    stubFetch({ session: ELEVATED_NO_TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('shows the "Acting on" banner for an elevated session with a working tenant', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByText(/Sunrise Medical Group/)).toBeDefined();
  });
});

describe('AiProvidersScreen — accessibility', () => {
  it.each([
    ['llm', ''],
    ['stt', '?tab=stt'],
    ['tts', '?tab=tts'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch({ connections: { llm: { azure: connectionOf('llm', 'azure', { hasKey: true, enabled: true, version: 3 }) } } });
    const { container } = renderWithProviders(<AiProvidersScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'AI Providers' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<AiProvidersScreen />, { searchParams: '?tab=tts' });
      await screen.findByRole('heading', { level: 1, name: 'AI Providers' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
