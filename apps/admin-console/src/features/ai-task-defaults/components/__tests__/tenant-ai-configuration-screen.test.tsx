/**
 * Tenant "AI Configuration" screen (tier 30-49, /ai-configuration).
 *
 * Replaces the dead-end EmptyState with two tabs:
 *   - "Effective models" (default): read-only resolution of ALL 9 task keys,
 *     each with its winning cascade tier. No pickers — the global-admin-only
 *     write posture is untouched.
 *   - "Cloud credentials": BYO Azure/Bedrock write-only key cards over the
 * `admin/providers/llm` routes, with OCC (If-Match) on save.
 *
 * §5 tests 12-15: loading skeletons, populated table, credential Configured/None
 * cards, error+retry, axe 0 violations per tab in BOTH themes, the working-tenant
 * gate + "Acting on" banner, and the OCC conflict path.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { AI_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault } from '../../api/types';
import type { ProviderConnection } from '../../api/providers-types';
import { CLOUD_PROVIDERS } from '../byo-credential-card';
import { TenantAiConfigurationScreen } from '../tenant-ai-configuration-screen';

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

function effectiveOf(taskKey: string, source: 'tenant' | 'system' | null = 'system'): EffectiveAiTaskDefault {
  return {
    tenantId: 'tnt-1',
    taskKey,
    modelSlug: `${taskKey}-model`,
    source,
    configJson: null,
    model: {
      id: `m-${taskKey}`,
      slug: `${taskKey}-model`,
      name: `Model for ${taskKey}`,
      provider: 'lm-studio',
      architecture: null,
      taskType: 'TEXT_GENERATION',
      format: 'GGUF',
      sourceUri: `${taskKey}-model`,
    },
  };
}

function harnessPolicySummary() {
  return {
    id: 'hp-1',
    tenantId: 'tnt-1',
    source: 'tenant' as const,
    entityFaithfulnessThreshold: 0.8,
    coverageThreshold: 0.75,
    citationPresenceThreshold: 0.6,
    numericDoseThreshold: 0.9,
    groundednessThreshold: 0.7,
    safetyEnabled: true,
    phiEnabled: true,
    phiFailClosed: true,
    safetyProvider: 'azure',
    safetyModel: 'content-safety',
    smrProvider: null,
    smrModel: null,
    maxRegen: 2,
    gateSlaSeconds: 300,
    gateEscalationSeconds: 600,
    toolAllowlist: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 4,
  };
}

function connectionOf(provider: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    tenantId: 'tnt-1',
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
  connections?: Record<string, ProviderConnection>;
  effectiveFails?: boolean;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = TENANT_SESSION, connections = {}, effectiveFails, custom }: StubOptions = {}): RecordedCall[] {
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
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults') {
        if (effectiveFails) return new Response('boom', { status: 500 });
        return Response.json(AI_TASK_KEYS.map((key) => effectiveOf(key)));
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/harness/policy') {
        return Response.json(harnessPolicySummary());
      }
      // Unified plane (TASK-572): the console reads LLM credentials at
      // `admin/providers/llm/:provider`.
      if (call.method === 'GET' && url.pathname.startsWith('/api/hope/admin/providers/llm/')) {
        const provider = url.pathname.split('/').pop() as string;
        const row = connections[provider] ?? connectionOf(provider);
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

describe('TenantAiConfigurationScreen — effective models tab', () => {
  it('renders a row for every one of the 9 task keys with its cascade-source badge', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Configuration' })).toBeDefined();
    for (const key of AI_TASK_KEYS) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    expect(AI_TASK_KEYS).toHaveLength(9);
    expect((await screen.findAllByText('system')).length).toBe(AI_TASK_KEYS.length);
  });

  it('is read-only — no model pickers or save controls (E3 write-lock untouched)', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    await screen.findByText(AI_TASK_KEYS[0]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('also renders the read-only effective HarnessPolicy summary (TASK-547 OD-2) with a deep link to its owning editor', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText('Entity faithfulness threshold')).toBeDefined();
    const link = screen.getByRole('link', { name: /edit tenant-controlled values/i });
    expect(link.getAttribute('href')).toBe('/harness/policy');
  });

  it('shows skeletons (not a spinner) while the effective read is in flight', () => {
    stubFetch();
    const { container } = renderWithProviders(<TenantAiConfigurationScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status', { name: /loading/i })).toBeNull();
  });

  it('surfaces an error state with retry when the effective read fails', async () => {
    stubFetch({ effectiveFails: true });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — cloud credentials tab', () => {
  it('renders a Configured card and a None card, and never exposes key material', async () => {
    stubFetch({
      connections: {
        azure: connectionOf('azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3, baseUrl: 'https://acme.openai.azure.com' }),
      },
    });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    expect(await screen.findByText('Azure OpenAI')).toBeDefined();
    expect(await screen.findByText('Amazon Bedrock')).toBeDefined();
    expect(await screen.findByText('OpenAI')).toBeDefined();
    expect(await screen.findByText('Anthropic')).toBeDefined();
    expect(await screen.findByText('Google Vertex AI')).toBeDefined();
    expect(await screen.findByText(/configured · v4/i)).toBeDefined();
    // Every provider EXCEPT the configured azure reads "not configured".
    expect((await screen.findAllByText('not configured')).length).toBe(CLOUD_PROVIDERS.length - 1);

    // The key input is a write-only password field with no value ever read back —
    // one per provider card (Vertex's is the service-account-JSON field).
    const keyInputs = document.querySelectorAll('input[type="password"]');
    expect(keyInputs.length).toBe(CLOUD_PROVIDERS.length);
    keyInputs.forEach((input) => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('sends If-Match from the row ETag on save (OCC) and clears the key field', async () => {
    const calls = stubFetch({
      connections: { azure: connectionOf('azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3 }) },
      custom: (call) => {
        if (call.method === 'PUT' && call.url.includes('/providers/llm/azure')) {
          return Response.json(connectionOf('azure', { hasKey: true, keyVersion: 5, enabled: true, version: 4 }), {
            headers: { etag: '"4"' },
          });
        }
        return undefined;
      },
    });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

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
        call.method === 'PUT' ? Response.json(connectionOf('bedrock', { hasKey: true, version: 1 }), { headers: { etag: '"1"' } }) : undefined,
    });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    // Cards load independently — wait for the bedrock card (index 1) to mount,
    // then save its key. Bedrock is the second CLOUD_PROVIDERS entry.
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
      connections: { azure: connectionOf('azure', { hasKey: true, enabled: true, version: 3 }) },
      custom: (call) => (call.method === 'PUT' ? new Response('conflict', { status: 412 }) : undefined),
    });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    const input = (await screen.findAllByLabelText(/API key/i))[0];
    fireEvent.change(input, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: /rotate key/i }));

    expect(await screen.findByText(/changed by another admin after you loaded it/i)).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — tenant scoping', () => {
  it('gates an elevated session without a working tenant on the NoTenant empty state', async () => {
    stubFetch({ session: ELEVATED_NO_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('shows the "Acting on" banner for an elevated session with a working tenant', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    expect(await screen.findByText(/Sunrise Medical Group/)).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — accessibility', () => {
  it.each([
    ['effective models', ''],
    ['cloud credentials', '?tab=credentials'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch({ connections: { azure: connectionOf('azure', { hasKey: true, enabled: true, version: 3 }) } });
    const { container } = renderWithProviders(<TenantAiConfigurationScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });
      await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
