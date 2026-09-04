/**
 * The one AI provider screen (`/ai-providers`, TASK-862).
 *
 * These cases pin the DECISIONS, not the markup:
 *   * tenancy is a CONTROL: an elevated caller lands on the SYSTEM tier and
 *     every read carries `?tenantId=SYSTEM`; switching to the working tenant
 *     re-parameterises the reads (the client-side shape of "every config cache
 *     key carries the tenant");
 *   * a tenant admin is pinned to their own tenant and sees no tier switch;
 *   * every capability the gateway serves has a tab;
 *   * the connection ceilings render and travel on the PUT body;
 *   * "Test connection" POSTs the ephemeral probe and never the write route;
 *   * the "Used by" panel lists routing bindings, and renders a 403 as
 *     "managed by the platform" rather than as an error;
 *   * 0 axe violations in both themes.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PermissionRule } from '@/shared/auth/ability';
import { PROVIDER_SERVICES } from '../../api/types';
import { AiProvidersScreen } from '../ai-providers-screen';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const ALL: PermissionRule[] = [{ action: 'manage', subject: 'all' }];
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

const ELEVATED_SESSION = {
  user: { id: 'u-9', username: 'super_admin', email: 'root@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-9', username: 'super_admin', email: 'root@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null as string | null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const TENANT_SESSION = {
  ...ELEVATED_SESSION,
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  effectiveIsElevated: false,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1', departmentId: null },
};

function row(service: string, provider: string, tenantId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId,
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
    maxConcurrent: null,
    rpmLimit: null,
    tpmLimit: null,
    timeoutS: null,
    version: 0,
    ...over,
  };
}

function binding(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    tenantId: SYSTEM_TENANT,
    taskKey: 'guardrail.validate',
    taskKind: 'CONTENT_SAFETY',
    displayName: 'granite-guardian-4.1-8b',
    providerConnectionId: null,
    modelId: 'mdl-1',
    modelRef: null,
    isDefault: true,
    enabled: true,
    status: 'ACTIVE',
    priority: 0,
    ...over,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

interface StubOptions {
  session?: typeof ELEVATED_SESSION;
  permissions?: PermissionRule[];
  routingForbidden?: boolean;
  /** Per-`tenantId` stored rows, keyed `service/provider`. */
  rows?: Record<string, Record<string, Record<string, unknown>>>;
  probe?: { ok: boolean; message: string; probe: 'auth' | 'reachability'; source: 'request' | 'tenant' | 'platform' };
}

function stubFetch({ session = ELEVATED_SESSION, permissions = ALL, routingForbidden, rows = {}, probe }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const raw = String(input);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url: raw, method, body });

      if (raw === '/api/auth/session') return Response.json(session);
      if (raw === '/api/hope/users/me/permission-checks') return Response.json({ userId: session.user.id, tenantId: 'tnt-1', permissions });

      const url = new URL(raw, 'http://test.local');
      const path = url.pathname;
      const tenantId = url.searchParams.get('tenantId') ?? 'cls';

      if (path === '/api/hope/admin/routing-policies') {
        if (routingForbidden) return Response.json({ statusCode: 403, message: 'managed by super admins' }, { status: 403 });
        return Response.json(tenantId === SYSTEM_TENANT ? [binding()] : []);
      }

      if (path.startsWith('/api/hope/admin/providers/')) {
        const [service, provider, action] = path.replace('/api/hope/admin/providers/', '').split('/');
        if (action === 'test' && method === 'POST') {
          return Response.json(probe ?? { ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' });
        }
        if (method === 'PUT') {
          const current = rows[tenantId]?.[`${service}/${provider}`] ?? {};
          return Response.json(row(service, provider, tenantId, { ...current, ...(body as Record<string, unknown>), hasKey: true, version: 1 }), {
            headers: { etag: '"1"' },
          });
        }
        const stored = rows[tenantId]?.[`${service}/${provider}`];
        return Response.json(row(service, provider, tenantId, stored), { headers: { etag: stored ? `"${stored.version ?? 1}"` : '"0"' } });
      }

      throw new Error(`Unhandled fetch: ${method} ${raw}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('AiProvidersScreen — tenancy is a control', () => {
  it('lands an elevated caller on the SYSTEM tier and reads every row with ?tenantId=SYSTEM', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'AI providers' })).toBeDefined();
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    const providerReads = calls.filter((c) => c.url.includes('/api/hope/admin/providers/') && c.method === 'GET');
    expect(providerReads.length).toBeGreaterThan(0);
    for (const call of providerReads) {
      expect(new URL(call.url, 'http://test.local').searchParams.get('tenantId')).toBe(SYSTEM_TENANT);
    }
    expect(screen.getByText('Scope: Platform default (SYSTEM)')).toBeDefined();
  });

  it('re-parameterises every read when the tier switches to the working tenant', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    const tenantTier = await screen.findByRole('radio', { name: /Tenant configuration — Sunrise Medical Group/ });
    await act(async () => {
      fireEvent.click(tenantTier);
    });

    await waitFor(() => {
      const tenantReads = calls.filter(
        (c) => c.url.includes('/api/hope/admin/providers/') && new URL(c.url, 'http://test.local').searchParams.get('tenantId') === 'tnt-1',
      );
      expect(tenantReads.length).toBeGreaterThan(0);
    });
    expect(await screen.findByText('Scope: Sunrise Medical Group')).toBeDefined();
    // Tenant-tier mutations carry the "Acting on" banner (rule 12 §5).
    expect((await screen.findByRole('status')).textContent).toMatch(/Acting on «Sunrise Medical Group»/);
  });

  it('pins a tenant admin to their own tenant with no tier switch', async () => {
    const calls = stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    expect(screen.queryByRole('radio', { name: /Platform default/ })).toBeNull();
    for (const call of calls.filter((c) => c.url.includes('/api/hope/admin/providers/'))) {
      expect(new URL(call.url, 'http://test.local').searchParams.get('tenantId')).toBe('tnt-1');
    }
  });
});

describe('AiProvidersScreen — the provider grid', () => {
  it('renders one tab per capability the gateway serves', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    const serviceTabs = screen.getAllByRole('tab');
    expect(serviceTabs).toHaveLength(PROVIDER_SERVICES.length);
  });

  it('shows the three-state badge and the ceilings on a stored row, and sends the ceilings on save', async () => {
    const calls = stubFetch({
      rows: { [SYSTEM_TENANT]: { 'llm/azure': { hasKey: true, keyVersion: 2, enabled: true, maxConcurrent: 8, timeoutS: 60, version: 3 } } },
    });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' })).closest('[aria-labelledby]') as HTMLElement;

    expect(card.textContent).toContain('Bring your own');
    const maxConcurrent = card.querySelector<HTMLInputElement>('input[id$="-maxConcurrent"]');
    expect(maxConcurrent?.value).toBe('8');

    const rpm = card.querySelector<HTMLInputElement>('input[id$="-rpmLimit"]');
    fireEvent.change(rpm as HTMLInputElement, { target: { value: '600' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save for Azure OpenAI/ }));
    });

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ maxConcurrent: 8, rpmLimit: 600, timeoutS: 60, tpmLimit: null, expectedVersion: 3 });
    expect((put?.body as Record<string, unknown>).apiKey).toBeUndefined();
    expect(new URL(put!.url, 'http://test.local').searchParams.get('tenantId')).toBe(SYSTEM_TENANT);
  });

  it('refuses a non-integer ceiling instead of sending it', async () => {
    stubFetch({ rows: { [SYSTEM_TENANT]: { 'llm/azure': { hasKey: true, enabled: true, version: 3 } } } });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' })).closest('[aria-labelledby]') as HTMLElement;

    fireEvent.change(card.querySelector('input[id$="-timeoutS"]') as HTMLInputElement, { target: { value: '0.5' } });
    expect(await screen.findByRole('alert')).toBeDefined();
    expect((screen.getByRole('button', { name: /Save for Azure OpenAI/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Test connection" POSTs the ephemeral probe with the typed key and never touches the write route', async () => {
    const calls = stubFetch({ probe: { ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' } });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'OpenAI' })).closest('[aria-labelledby]') as HTMLElement;

    fireEvent.change(card.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'sk-test' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test the OpenAI connection' }));
    });

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/llm/openai/test'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/test'));
    expect(post?.body).toMatchObject({ apiKey: 'sk-test' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/credential verified/)));
  });

  it('reports a failed probe as an error toast, never as a saved row', async () => {
    const calls = stubFetch({ probe: { ok: false, message: 'Rejected — invalid key', probe: 'auth', source: 'request' } });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'OpenAI' })).closest('[aria-labelledby]') as HTMLElement;
    fireEvent.change(card.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'bad' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test the OpenAI connection' }));
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/invalid key/)));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('AiProvidersScreen — used by', () => {
  it('lists the routing bindings of the selected tier with the elected default marked', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    const table = await screen.findByRole('table', { name: 'Task configurations bound to a provider' });
    expect(table.textContent).toContain('guardrail.validate');
    expect(table.textContent).toContain('granite-guardian-4.1-8b');
    expect(table.textContent).toContain('default');
  });

  it('renders the SUPER_ADMIN-only routing plane 403 as "managed by the platform", not as an error', async () => {
    stubFetch({ session: TENANT_SESSION, routingForbidden: true });
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByText('Managed by the platform')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('AiProvidersScreen — accessibility', () => {
  it('has no axe violations (light theme)', async () => {
    stubFetch();
    const { container } = renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });
    await screen.findByRole('table', { name: 'Task configurations bound to a provider' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations (dark theme)', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<AiProvidersScreen />);
      await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
