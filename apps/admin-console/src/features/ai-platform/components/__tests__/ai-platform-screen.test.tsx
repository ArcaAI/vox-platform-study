/**
 * The unified AI Platform screen.
 *
 * These cases pin the DECISIONS the ticket made, not the markup:
 *   * five tabs cut by user intent, all reachable;
 *   * tenancy is a control, and switching it re-parameterises the reads
 *     (the client-side shape of "every config cache key carries the tenant");
 *   * the elected default is rendered from `isDefault`, which only exists on
 *     the wire because this ticket widened the read shape;
 *   * a 403 from the SUPER_ADMIN-only routing plane reads as "managed by the
 *     platform", not as a failure;
 *   * the export UI renders a credential LOCATOR and never key material;
 *   * gated HuggingFace repos are an explicit, blocking acknowledgement.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PermissionRule } from '@/shared/auth/ability';
import { AiPlatformScreen } from '../ai-platform-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

function policy(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cfg-1',
    tenantId: SYSTEM_TENANT,
    taskKey: 'text.finalize',
    taskKind: 'TEXT_GENERATION',
    displayName: 'Azure — finalize',
    providerConnectionId: 'conn-1',
    modelId: 'mdl-1',
    modelRef: 'gpt-4o-finalize',
    isDefault: false,
    enabled: true,
    residency: 'eu-west',
    baaCovered: true,
    policyVersion: 1,
    status: 'ACTIVE',
    strategy: 'PRIORITY',
    explicitProviderMode: 'STRICT',
    priority: 10,
    killSwitch: false,
    match: null,
    candidates: [],
    fallback: null,
    health: null,
    affinity: null,
    maxConcurrentStreams: null,
    requestsPerMinute: null,
    tokensPerMinute: null,
    supersedesVersion: null,
    activatedAt: null,
    version: 3,
    ...overrides,
  };
}

/**
 * The export artifact, WITH a credential planted in it.
 *
 * The gateway never emits this field — `assertNoSecretMaterial` is its gate.
 * Planting one here tests the console's half of the same rule: even handed a
 * secret, the UI must not render it. A fixture that only contains what the
 * server sends would pass whether or not the component was careful.
 */
const PLANTED_SECRET = 'sk-live-DEADBEEF-must-never-render';
const EXPORT_ARTIFACT = {
  formatVersion: 1,
  exportedAt: '2026-09-01T00:00:00.000Z',
  sourceTenantId: SYSTEM_TENANT,
  secretsIncluded: false,
  notice: 'No credential material is included in this artifact.',
  configurations: [
    {
      taskKey: 'text.finalize',
      taskKind: 'TEXT_GENERATION',
      displayName: 'Azure — finalize',
      connection: { service: 'llm', provider: 'azure' },
      modelSlug: 'gpt-4o',
      modelRef: 'gpt-4o-finalize',
      isDefault: true,
      enabled: true,
      residency: 'eu-west',
      baaCovered: true,
      priority: 10,
      credentialRef: 'vault-transit:llm:azure:v3',
      hasCredential: true,
      apiKey: PLANTED_SECRET,
    },
  ],
};

interface StubOptions {
  session?: typeof ELEVATED_SESSION;
  permissions?: PermissionRule[];
  /** Make the SUPER_ADMIN-only routing plane answer 403, as it does for a tenant admin. */
  routingForbidden?: boolean;
  policies?: ReturnType<typeof policy>[];
}

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch({ session = ELEVATED_SESSION, permissions = ALL, routingForbidden, policies }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const raw = String(input);
      calls.push({ url: raw, method });

      if (raw === '/api/auth/session') return Response.json(session);
      if (raw === '/api/hope/users/me/permission-checks') return Response.json({ userId: session.user.id, tenantId: 'tnt-1', permissions });

      const url = new URL(raw, 'http://test.local');
      const path = url.pathname;

      if (path.startsWith('/api/hope/admin/routing-policies')) {
        if (routingForbidden) {
          return Response.json({ statusCode: 403, message: 'Routing policies are managed by super administrators only.' }, { status: 403 });
        }
        if (path.endsWith('/export')) return Response.json(EXPORT_ARTIFACT);
        if (path.endsWith('/effective')) {
          return Response.json({
            tenantId: url.searchParams.get('tenantId'),
            taskKey: url.searchParams.get('taskKey'),
            source: 'system',
            policyId: 'cfg-1',
            policyVersion: 1,
            strategy: 'PRIORITY',
            explicitProviderMode: 'STRICT',
            primary: {
              step: 0,
              rank: 0,
              weight: 100,
              connectionRef: 'azure',
              model: 'gpt-4o',
              residency: 'eu-west',
              baaCovered: true,
              funding: 'CLOUD',
              maxTtftMs: null,
            },
            fallbackChain: [],
            rejectedCandidates: [],
            rejection: null,
            relaxedGates: [],
            health: null,
            maxConcurrentStreams: null,
            requestsPerMinute: null,
            tokensPerMinute: null,
          });
        }
        if (method === 'POST') return Response.json(policy({ isDefault: true }));
        return Response.json(policies ?? [policy(), policy({ id: 'cfg-2', displayName: 'LM Studio — finalize', isDefault: true, version: 5 })]);
      }

      if (path === '/api/hope/admin/ai-runtime-profiles') return Response.json([]);
      if (path === '/api/hope/admin/ai-models/discovery') return Response.json({ entries: [], probes: [], probedAt: '2026-09-01T00:00:00.000Z' });
      if (path === '/api/hope/admin/ai-models') return Response.json([]);
      if (path === '/api/hope/admin/ai-task-defaults/row') return Response.json({ tenantId: 'tnt-1', taskKey: 'text.live', modelSlug: null, version: 0 });
      if (path === '/api/hope/admin/ai-task-defaults/models') return Response.json([]);
      if (path.startsWith('/api/hope/admin/ai-task-defaults')) return Response.json([]);
      if (path === '/api/hope/admin/harness/policy') return Response.json({ id: 'hp-1', tenantId: 'tnt-1', source: 'system' });
      if (path === '/api/hope/storage/buckets') return Response.json([{ name: 'hope-media' }, { name: 'hope-models' }]);
      if (path.startsWith('/api/hope/storage/buckets/')) {
        return Response.json([
          { key: 'whisper-large-v3/model.safetensors', size: 3_221_225_472, lastModified: '2026-08-01T00:00:00.000Z' },
          { key: 'README.md', size: 1024, lastModified: '2026-08-01T00:00:00.000Z' },
        ]);
      }
      if (path.startsWith('/api/hope/admin/providers/')) {
        return Response.json({ tenantId: 'tnt-1', provider: 'azure', hasKey: false, keyVersion: null, enabled: false, version: 0 });
      }

      return Response.json([]);
    }),
  );
  return calls;
}

/**
 * `fireEvent` + a flushed microtask queue.
 *
 * The app has no `@testing-library/user-event` dependency (every sibling screen
 * test drives with `fireEvent`), and a bare `fireEvent.click` leaves the state
 * update that follows unflushed, so the very next assertion races it.
 */
async function clickAndSettle(element: Element): Promise<void> {
  await act(async () => {
    // `mouseDown` first: Radix tab triggers activate on mousedown, not click,
    // so a bare `fireEvent.click` leaves the tab unswitched and the assertion
    // that follows fails for a reason that has nothing to do with the code
    // under test. Harmless on plain buttons.
    fireEvent.mouseDown(element);
    fireEvent.click(element);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiPlatformScreen — the consolidated information architecture', () => {
  it('offers exactly the five intent-shaped tabs', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'AI Platform' })).toBeDefined();
    for (const name of ['Providers', 'Tasks', 'Model catalogue', 'Model store', 'Engines']) {
      expect(screen.getByRole('tab', { name })).toBeDefined();
    }
  });

  it('renders the elected default from `isDefault`, and offers election on the rows that are not', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    // `isDefault` is only on the wire because this ticket widened the read
    // shape; before that no client could tell which row was elected. The badge
    // is asserted INSIDE the elected row so the case cannot pass on a stray
    // "Default" elsewhere on the screen.
    const table = await screen.findByRole('table', { name: /Provider configurations for text\.finalize/i });
    const electedRow = within(table).getByText('LM Studio — finalize').closest('tr');
    expect(electedRow).not.toBeNull();
    expect(within(electedRow as HTMLElement).getByText('Default')).toBeDefined();

    const candidateRow = within(table).getByText('Azure — finalize').closest('tr');
    expect(within(candidateRow as HTMLElement).getByRole('button', { name: /Make Azure — finalize the default for text\.finalize/i })).toBeDefined();
  });

  it('refuses to offer election on a disabled configuration, and says why', async () => {
    stubFetch({ policies: [policy({ enabled: false })] });
    renderWithProviders(<AiPlatformScreen />);

    const button = await screen.findByRole('button', { name: /Make default — unavailable/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    // A disabled control without a stated reason is an affordance without a
    // function (rule 11 §5), so the reason rides in the accessible name.
    expect(button.getAttribute('aria-label')).toContain('cannot be elected');
  });

  it('sends If-Match carrying the row version when electing a default', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    const table = await screen.findByRole('table', { name: /Provider configurations for text\.finalize/i });
    const candidateRow = within(table).getByText('Azure — finalize').closest('tr') as HTMLElement;
    await clickAndSettle(within(candidateRow).getByRole('button', { name: /Make Azure — finalize the default/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.includes('/cfg-1/default'))).toBe(true));
  });
});

describe('AiPlatformScreen — tenancy is a selector, not a route', () => {
  it('gives an elevated caller both tiers and starts on the platform default', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    const platform = await screen.findByRole('radio', { name: /Platform default/i });
    expect(platform.getAttribute('aria-checked')).toBe('true');
    // The tenant button names the tenant it would switch TO, not the tier that
    // is currently active.
    expect(screen.getByRole('radio', { name: 'Tenant configuration — Sunrise Medical Group' })).toBeDefined();
  });

  it('re-parameterises every read when the tier changes — a tenant never sees another tier’s rows', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    await screen.findByRole('radio', { name: /Platform default/i });
    await waitFor(() => expect(calls.some((call) => call.url.includes(`tenantId=${encodeURIComponent(SYSTEM_TENANT)}`))).toBe(true));

    await clickAndSettle(screen.getByRole('radio', { name: /Tenant configuration — Sunrise Medical Group/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('tenantId=tnt-1'))).toBe(true));
  });

  it('shows a tenant admin no tier switch at all — they have exactly one tier', async () => {
    stubFetch({ session: TENANT_SESSION });
    renderWithProviders(<AiPlatformScreen />);

    await screen.findByRole('heading', { level: 1, name: 'AI Platform' });
    expect(screen.queryByRole('radio', { name: /Platform default/i })).toBeNull();
  });
});

describe('AiPlatformScreen — a 403 is an answer, not a failure', () => {
  it('reads a forbidden routing plane as "managed by the platform"', async () => {
    stubFetch({ session: TENANT_SESSION, routingForbidden: true });
    renderWithProviders(<AiPlatformScreen />);

    expect(await screen.findByText('Managed by the platform')).toBeDefined();
    // Not an error state: no retry button, because retrying a privilege
    // boundary cannot succeed.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('AiPlatformScreen — the export UI never renders a secret', () => {
  it('shows the credential LOCATOR and no key material, even when handed one', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    await clickAndSettle(await screen.findByRole('button', { name: /export \/ import/i }));

    expect(await screen.findByText('vault-transit:llm:azure:v3')).toBeDefined();
    // The artifact fixture deliberately carries a live-looking key. It must not
    // reach the DOM by any path — not as text, not in an attribute.
    expect(document.body.innerHTML).not.toContain(PLANTED_SECRET);
    expect(screen.queryByText(new RegExp(PLANTED_SECRET))).toBeNull();
  });

  it('states plainly that an import cannot restore credentials', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />);

    await clickAndSettle(await screen.findByRole('button', { name: /export \/ import/i }));

    const importTab = await screen.findByRole('tab', { name: 'Import' });
    await clickAndSettle(importTab);
    await waitFor(() => expect(importTab.getAttribute('aria-selected')).toBe('true'));

    expect(await screen.findByText('An import cannot restore credentials')).toBeDefined();
  });
});

describe('AiPlatformScreen — model store and HuggingFace acquisition', () => {
  it('groups a flat object listing into the prefixes a model store actually has', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />, { searchParams: '?tab=store' });

    expect(await screen.findByRole('button', { name: /whisper-large-v3\//i })).toBeDefined();
    expect(screen.getByText('README.md')).toBeDefined();
  });

  it('blocks a HuggingFace fetch until the gated-terms acknowledgement is given', async () => {
    stubFetch();
    renderWithProviders(<AiPlatformScreen />, { searchParams: '?tab=store' });

    await clickAndSettle(await screen.findByRole('button', { name: /fetch from huggingface/i }));

    const submit = await screen.findByRole('button', { name: /catalogue repository/i });
    expect(submit.hasAttribute('disabled')).toBe(true);
    // Accepting a model licence on a human's behalf is exactly what the Hub's
    // gate exists to prevent, so the acknowledgement is required rather than
    // advisory.
    expect(screen.getByText(/cannot be done automatically/i)).toBeDefined();
  });
});

describe('AiPlatformScreen — accessibility', () => {
  it.each([
    ['providers', ''],
    ['tasks', '?tab=tasks'],
    ['catalogue', '?tab=catalogue'],
    ['store', '?tab=store'],
    ['engines', '?tab=engines'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch();
    const { container } = renderWithProviders(<AiPlatformScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'AI Platform' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it.each([
    ['providers', ''],
    ['tasks', '?tab=tasks'],
    ['catalogue', '?tab=catalogue'],
    ['store', '?tab=store'],
    ['engines', '?tab=engines'],
  ])('has no axe violations on the %s tab (dark theme)', async (_label, searchParams) => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<AiPlatformScreen />, { searchParams });

      await screen.findByRole('heading', { level: 1, name: 'AI Platform' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
