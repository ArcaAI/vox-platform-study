/**
 * The one AI provider screen (`/ai-providers`).
 *
 * These cases pin the DECISIONS, not the markup:
 *   * TENANCY IS THE WORKING TENANT (TASK-932 R-12) — there is no scope toggle.
 *     Elevated with no working tenant → the platform tier; with one → that
 *     tenant, and the "Acting on" banner; a tenant admin → their own tenant;
 *   * the platform view leads with the built-in engines and the weight store,
 *     because "where is LM Studio's endpoint" was the question this screen could
 *     not answer at all;
 *   * platform cards never speak tenant wording, and a keyless built-in row
 *     reads as a DEFAULT, not as "no key · Disabled for this tenant";
 *   * "Reset to default" exists on platform-managed rows and POSTs the reset
 *     route, never the write route;
 *   * the tenant view carries only BYO cards and no platform plane;
 *   * the connection ceilings render and travel on the PUT body;
 *   * "Test connection" POSTs the ephemeral probe and never the write route;
 *   * the "Used by" panel lists routing bindings, and renders a 403 as
 *     "managed by the platform" rather than as an error;
 *   * 0 axe violations in both themes.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PermissionRule } from '@/shared/auth/ability';
import { AiProvidersScreen } from '../ai-providers-screen';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const ALL: PermissionRule[] = [{ action: 'manage', subject: 'all' }];
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

/** Elevated, with a working tenant selected → the TENANT tier. */
const WORKING_TENANT_SESSION = {
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

/** Elevated, NO working tenant → the PLATFORM tier. */
const PLATFORM_SESSION = {
  ...WORKING_TENANT_SESSION,
  workingTenantId: null,
  workingTenantName: null,
  effectiveTenantId: null,
};

/**
 * A tenant admin, as `toSafeSession` actually projects one (TASK-954): NO
 * working tenant and no working-tenant NAME — the effective scope is its own
 * tenant. The earlier fixture inherited `workingTenantId: 'tnt-1'` from the
 * elevated session above, a shape a tenant-bound session never has, which is
 * how the screen's fall-through to SYSTEM (and the 403 on every card) went
 * unnoticed.
 */
const TENANT_SESSION = {
  ...WORKING_TENANT_SESSION,
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1' },
  isElevated: false,
  workingTenantId: null,
  workingTenantName: null,
  effectiveIsElevated: false,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1', departmentId: null },
  effectiveTenantId: 'tnt-1' as string | null,
};

/** The platform fallback for `llm` as the gateway projects it for tenant `tnt-1`. */
function platformDefaults(service: string, tenantId: string, over: Partial<{ entitled: boolean }> = {}) {
  return {
    service,
    tenantId,
    entitled: over.entitled ?? true,
    connections: [
      { ...row(service, 'azure', SYSTEM_TENANT, { hasKey: true, enabled: true, baseUrl: 'https://platform.openai.azure.com', version: 3 }), resolution: 'inherited' },
      { ...row(service, 'bedrock', SYSTEM_TENANT), resolution: 'not-configured' },
      { ...row(service, 'openai', SYSTEM_TENANT, { hasKey: true, enabled: false, version: 2 }), resolution: 'off' },
      { ...row(service, 'anthropic', SYSTEM_TENANT), resolution: 'not-configured' },
      { ...row(service, 'vertex', SYSTEM_TENANT), resolution: 'not-configured' },
    ],
  };
}

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
  session?: typeof WORKING_TENANT_SESSION;
  permissions?: PermissionRule[];
  routingForbidden?: boolean;
  /** Routing rows the "Used by" panel lists, when a case needs its own. */
  bindings?: Record<string, unknown>[];
  /** Per-`tenantId` stored rows, keyed `service/provider`. */
  rows?: Record<string, Record<string, Record<string, unknown>>>;
  probe?: { ok: boolean; message: string; probe: 'auth' | 'reachability'; source: 'request' | 'tenant' | 'platform' };
  readiness?: { checkedAt: string; engines: { provider: string; status: 'up' | 'down' | 'unknown'; latencyMs: number | null; loadedCount: number; listedCount: number; detail: string | null }[] };
}

function stubFetch({ session = PLATFORM_SESSION, permissions = ALL, routingForbidden, bindings, rows = {}, probe, readiness }: StubOptions = {}): RecordedCall[] {
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

      // The tenant catalog names the scope for a tenant admin (own row only).
      if (path === '/api/hope/admin/tenants') {
        return Response.json({ data: [{ id: 'tnt-1', name: 'Sunrise Medical Group', key: 'sunrise' }], count: 1, limit: 500, page: 0 });
      }

      if (path === '/api/hope/admin/ai-services/readiness') {
        return Response.json(readiness ?? { checkedAt: '2026-09-09T00:00:00.000Z', engines: [] });
      }

      if (path === '/api/hope/admin/routing-policies') {
        if (routingForbidden) return Response.json({ statusCode: 403, message: 'managed by super admins' }, { status: 403 });
        if (bindings) return Response.json(bindings);
        return Response.json(tenantId === SYSTEM_TENANT ? [binding()] : []);
      }

      if (path.startsWith('/api/hope/admin/providers/')) {
        const [service, provider, action] = path.replace('/api/hope/admin/providers/', '').split('/');
        // TASK-958 — `GET :service` is the tenant's whole connection list; the
        // tenant tier reads it once per tab to build each provider's card group.
        // Stored rows are projected into the §4.1 shape, so a row here is its
        // provider's DEFAULT connection, which is what every one of them is.
        if (provider === undefined) {
          const stored = rows[tenantId] ?? {};
          return Response.json(
            Object.entries(stored)
              .filter(([key]) => key.startsWith(`${service}/`))
              .map(([key, value]) => {
                const slug = key.slice(`${service}/`.length);
                return {
                  slug,
                  name: null,
                  isDefault: true,
                  ...row(service!, slug, tenantId, value),
                  id: (value as { id?: string }).id ?? `conn-${tenantId}-${service}-${slug}`,
                };
              }),
          );
        }
        // TASK-954 — the read-only platform fallback (tenant tier only; 400 on SYSTEM).
        if (provider === 'platform-defaults') {
          if (tenantId === SYSTEM_TENANT) return Response.json({ statusCode: 400, message: 'top of the cascade' }, { status: 400 });
          return Response.json(platformDefaults(service!, tenantId));
        }
        if (action === 'test' && method === 'POST') {
          return Response.json(probe ?? { ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' });
        }
        if (action === 'reset' && method === 'POST') {
          return Response.json(row(service!, provider!, tenantId, { baseUrl: 'http://hope-lmstudio:1234/v1', enabled: true, hasKey: true, version: 4 }));
        }
        if (method === 'PUT') {
          const current = rows[tenantId]?.[`${service}/${provider}`] ?? {};
          return Response.json(row(service!, provider!, tenantId, { ...current, ...(body as Record<string, unknown>), hasKey: true, version: 1 }), {
            headers: { etag: '"1"' },
          });
        }
        const stored = rows[tenantId]?.[`${service}/${provider}`];
        return Response.json(row(service!, provider!, tenantId, stored), { headers: { etag: stored ? `"${stored.version ?? 1}"` : '"0"' } });
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

describe('AiProvidersScreen — the working tenant decides the scope (R-12)', () => {
  it('puts an elevated caller with NO working tenant on the platform tier and reads with ?tenantId=SYSTEM', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'AI providers' })).toBeDefined();
    await screen.findByRole('heading', { level: 3, name: 'LM Studio' });

    const providerReads = calls.filter((c) => c.url.includes('/api/hope/admin/providers/') && c.method === 'GET');
    expect(providerReads.length).toBeGreaterThan(0);
    for (const call of providerReads) {
      expect(new URL(call.url, 'http://test.local').searchParams.get('tenantId')).toBe(SYSTEM_TENANT);
    }
    expect(screen.getByText('Scope: Platform (SYSTEM)')).toBeDefined();
  });

  it('has NO scope toggle — the shell switcher is the only tenancy control', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'LM Studio' });

    expect(screen.queryByRole('radio', { name: /Platform default/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Configuration tier' })).toBeNull();
  });

  it('follows the working tenant into the tenant tier, banner and all', async () => {
    const calls = stubFetch({ session: WORKING_TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    for (const call of calls.filter((c) => c.url.includes('/api/hope/admin/providers/'))) {
      expect(new URL(call.url, 'http://test.local').searchParams.get('tenantId')).toBe('tnt-1');
    }
    expect(screen.getByText('Scope: Sunrise Medical Group')).toBeDefined();
    // Tenant-tier mutations carry the "Acting on" banner (rule 12 §5).
    expect((await screen.findByRole('status')).textContent).toMatch(/Acting on «Sunrise Medical Group»/);
  });

  it('pins a tenant admin to their own tenant — with no working tenant — and names it from the tenant catalog', async () => {
    const calls = stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    const providerReads = calls.filter((c) => c.url.includes('/api/hope/admin/providers/'));
    expect(providerReads.length).toBeGreaterThan(0);
    for (const call of providerReads) {
      expect(new URL(call.url, 'http://test.local').searchParams.get('tenantId')).toBe('tnt-1');
    }
    expect(await screen.findByText('Scope: Sunrise Medical Group')).toBeDefined();
    // Tenant wording, no "clear the working tenant" instruction a tenant admin cannot follow.
    expect(screen.getByText(/Your own vendor connections/)).toBeDefined();
    expect(screen.queryByText(/Clear the working tenant/)).toBeNull();
  });

  // TASK-954 — the owner's rule for the tenant tier: see and configure your
  // own providers, and see the platform fallback READ-ONLY.
  it('shows a tenant admin the platform defaults read-only, per capability, and never the platform sections', async () => {
    const calls = stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    const panel = await screen.findByRole('region', { name: 'Platform defaults' });
    expect(within(panel).getByText('read-only')).toBeDefined();
    const table = within(panel).getByRole('table', { name: 'Platform defaults for llm' });
    // One row per cloud provider, with the cascade's verdict for THIS tenant.
    expect(within(table).getByText('Azure OpenAI')).toBeDefined();
    expect(within(table).getByText('Serving you')).toBeDefined();
    expect(within(table).getByText('Off')).toBeDefined();
    expect(within(table).getAllByText('Not configured').length).toBe(3);
    expect(within(table).getByText('https://platform.openai.azure.com')).toBeDefined();
    // Nothing on the panel is a control — no input, no button.
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();

    // The read is the tenant's own, never the SYSTEM tier.
    const defaultsRead = calls.find((c) => c.url.includes('/admin/providers/llm/platform-defaults'));
    expect(defaultsRead).toBeDefined();
    expect(new URL(defaultsRead!.url, 'http://test.local').searchParams.get('tenantId')).toBe('tnt-1');

    // The card that inherits says so; the platform-only sections never render.
    expect(screen.getByText('The platform default serves this provider for you today.')).toBeDefined();
    expect(screen.queryByText('Built-in inference services')).toBeNull();
    expect(screen.queryByText('Model registry (built-in)')).toBeNull();
  });

  it('never reads the platform defaults on the platform tier', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'LM Studio' });
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });
    expect(calls.some((c) => c.url.includes('/platform-defaults'))).toBe(false);
    expect(screen.queryByRole('region', { name: 'Platform defaults' })).toBeNull();
  });
});

describe('AiProvidersScreen — the platform view (R-3, R-11)', () => {
  it('renders the three platform sections, built-ins first', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    // Wait for the session to arrive: until it does the screen shows a skeleton
    // rather than guessing a tier, so only the always-present "Used by" heading
    // exists (which `findAllByRole` would otherwise settle for).
    await screen.findByRole('heading', { level: 2, name: 'Built-in inference services' });
    const headings = await screen.findAllByRole('heading', { level: 2 });
    const titles = headings.map((h) => h.textContent);
    expect(titles).toContain('Built-in inference services');
    expect(titles).toContain('Platform default cloud connections');
    expect(titles).toContain('Model registry (built-in)');
    expect(titles.indexOf('Built-in inference services')).toBeLessThan(titles.indexOf('Platform default cloud connections'));
  });

  it('renders a card for every built-in engine and for the weight store', async () => {
    stubFetch();
    renderWithProviders(<AiProvidersScreen />);

    for (const label of ['LM Studio', 'Ollama', 'vLLM', 'llama.cpp', 'Hugging Face Hub', 'S3 / MinIO weight store']) {
      expect(await screen.findByRole('heading', { level: 3, name: label }), `${label} card missing`).toBeDefined();
    }
  });

  it('never speaks tenant wording on a platform card — the R-11 defect', async () => {
    stubFetch({
      rows: { [SYSTEM_TENANT]: { 'model-registry/s3': { enabled: true, hasKey: false, version: 2, extraJson: { inheritsPlatformStorage: true } } } },
    });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'S3 / MinIO weight store' })).closest('[aria-labelledby]') as HTMLElement;

    expect(card.textContent).not.toContain('Disabled for this tenant');
    expect(card.textContent).toContain('Built-in default');
    expect(card.textContent).toContain('Using platform storage credentials');
  });

  it('shows the readiness the sweep measured, and says "not measured" rather than inventing a verdict', async () => {
    stubFetch({
      readiness: {
        checkedAt: '2026-09-09T00:00:00.000Z',
        engines: [{ provider: 'lm-studio', status: 'up', latencyMs: 12, loadedCount: 1, listedCount: 4, detail: null }],
      },
    });
    renderWithProviders(<AiProvidersScreen />);

    const lmStudio = (await screen.findByRole('heading', { level: 3, name: 'LM Studio' })).closest('[aria-labelledby]') as HTMLElement;
    expect(lmStudio.textContent).toContain('reachable');
    expect(lmStudio.textContent).toContain('1/4 loaded');

    const ollama = (await screen.findByRole('heading', { level: 3, name: 'Ollama' })).closest('[aria-labelledby]') as HTMLElement;
    expect(ollama.textContent).not.toContain('not answering');
  });

  it('"Reset to default" POSTs the reset route after a confirmation, and never the write route', async () => {
    const calls = stubFetch({ rows: { [SYSTEM_TENANT]: { 'llm/lm-studio': { baseUrl: 'http://localhost:1234/v1', enabled: true, hasKey: true, version: 3 } } } });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'LM Studio' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset LM Studio to its built-in default' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    });

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/llm/lm-studio/reset'))).toBe(true));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const reset = calls.find((c) => c.url.includes('/reset'))!;
    expect(new URL(reset.url, 'http://test.local').searchParams.get('tenantId')).toBe(SYSTEM_TENANT);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/restored to its built-in default/)));
  });

  it('lets an engine endpoint be saved without a key — a self-hosted engine authenticates nobody', async () => {
    const calls = stubFetch({ rows: { [SYSTEM_TENANT]: { 'llm/lm-studio': { baseUrl: 'http://hope-lmstudio:1234/v1', enabled: true, version: 3 } } } });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'LM Studio' })).closest('[aria-labelledby]') as HTMLElement;

    fireEvent.change(card.querySelector('input[id$="-baseUrl"]') as HTMLInputElement, { target: { value: 'http://localhost:1234/v1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save key for LM Studio|Save for LM Studio/ }));
    });

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/llm/lm-studio'))).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>).baseUrl).toBe('http://localhost:1234/v1');
  });
});

describe('AiProvidersScreen — the tenant view', () => {
  it('shows only BYO cards: no built-in engine and no weight store', async () => {
    stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    expect(screen.queryByRole('heading', { level: 3, name: 'LM Studio' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'S3 / MinIO weight store' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Built-in inference services' })).toBeNull();
  });

  it('offers no reset — built-in defaults are not a tenant concept', async () => {
    stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });

    expect(screen.queryByRole('button', { name: /Reset .* to its built-in default/ })).toBeNull();
  });

  it('shows the three-state badge and the ceilings on a stored row, and sends the ceilings on save', async () => {
    const calls = stubFetch({
      session: TENANT_SESSION,
      rows: { 'tnt-1': { 'llm/azure': { hasKey: true, keyVersion: 2, enabled: true, maxConcurrent: 8, timeoutS: 60, version: 3 } } },
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
    expect(new URL(put!.url, 'http://test.local').searchParams.get('tenantId')).toBe('tnt-1');
  });

  it('refuses a non-integer ceiling instead of sending it', async () => {
    stubFetch({ session: TENANT_SESSION, rows: { 'tnt-1': { 'llm/azure': { hasKey: true, enabled: true, version: 3 } } } });
    renderWithProviders(<AiProvidersScreen />);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' })).closest('[aria-labelledby]') as HTMLElement;

    fireEvent.change(card.querySelector('input[id$="-timeoutS"]') as HTMLInputElement, { target: { value: '0.5' } });
    expect(await screen.findByRole('alert')).toBeDefined();
    expect((screen.getByRole('button', { name: /Save for Azure OpenAI/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Test connection" POSTs the ephemeral probe with the typed key and never touches the write route', async () => {
    const calls = stubFetch({ session: TENANT_SESSION, probe: { ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' } });
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
    const calls = stubFetch({ session: TENANT_SESSION, probe: { ok: false, message: 'Rejected — invalid key', probe: 'auth', source: 'request' } });
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

  /**
   * TASK-958 D-7 — "what breaks if I disable this?" is now a question about a
   * CONNECTION, not a provider: two OpenAI accounts serve the same provider
   * name, and the routing row binds exactly one of them.
   */
  it('names the connection a routing row binds, and keeps "platform-served" for a row that binds none', async () => {
    stubFetch({
      session: TENANT_SESSION,
      bindings: [
        binding({ id: 'cfg-1', tenantId: 'tnt-1', taskKey: 'guardrail.validate', providerConnectionId: 'conn-2' }),
        binding({ id: 'cfg-2', tenantId: 'tnt-1', taskKey: 'nlp.classify', providerConnectionId: null }),
      ],
      rows: { 'tnt-1': { 'llm/openai-research': { id: 'conn-2', hasKey: true, enabled: true, version: 2 } } },
    });
    renderWithProviders(<AiProvidersScreen />);

    const table = await screen.findByRole('table', { name: 'Task configurations bound to a provider' });
    expect(within(table).getByRole('columnheader', { name: 'Connection' })).toBeDefined();
    // Resolved from the tenant's own connection list, so the cell names the ROW
    // (its slug, since this one carries no display name) rather than repeating
    // the vendor both rows share.
    await waitFor(() => expect(within(table).getByText('openai-research')).toBeDefined());
    expect(within(table).getByText('platform-served')).toBeDefined();
  });

  it('renders the SUPER_ADMIN-only routing plane 403 as "managed by the platform", not as an error', async () => {
    stubFetch({ session: TENANT_SESSION, routingForbidden: true });
    renderWithProviders(<AiProvidersScreen />);

    expect(await screen.findByText('Managed by the platform')).toBeDefined();
    // No bindings table — the read-only platform-defaults table (TASK-954) is a different table.
    expect(screen.queryByRole('table', { name: 'Task configurations bound to a provider' })).toBeNull();
  });
});

describe('AiProvidersScreen — accessibility', () => {
  it('has no axe violations on the platform view (light theme)', async () => {
    stubFetch();
    const { container } = renderWithProviders(<AiProvidersScreen />);
    await screen.findByRole('heading', { level: 3, name: 'LM Studio' });
    await screen.findByRole('table', { name: 'Task configurations bound to a provider' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations on the tenant view (dark theme)', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch({ session: TENANT_SESSION });
      const { container } = renderWithProviders(<AiProvidersScreen />);
      await screen.findByRole('heading', { level: 3, name: 'Azure OpenAI' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
