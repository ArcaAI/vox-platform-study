/**
 * TDD screen tests for frame 25 (tenant half — Tenant profile),
 * redesign: three tabs (Organization identity from GET /tenant/me, Plan & usage
 * from GET /entitlements/me, Settings with a category sub-nav over the editable
 * tenant/me/config rows). Settings saves send per-row If-Match over PATCH
 * /tenant/me/config (OCC alert on 412), and the frame's NoTenant variant covers
 * tenant-less global admins.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { Tenant, TenantConfig } from '@/features/tenants/api/types';
import type { SafeSession } from '@/shared/auth/hooks';
import { renderWithProviders } from '@/test/render';
import { TenantProfileScreen } from '../tenant-profile-screen';

/** Elevated (admin) session — the default for every pre-existing test below. */
const ELEVATED_SESSION: SafeSession = {
  user: { id: 'admin-1', username: 'super_admin', email: 'root@hope.dev', roles: ['SUPER_ADMIN'], tenantId: null },
  isElevated: true,
  workingTenantId: 'ten-1',
  workingTenantName: 'Sunrise Medical Group',
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'admin-1', username: 'super_admin', email: 'root@hope.dev', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'ten-1',
};

/** A non-elevated session: a real end-user, or an operator impersonating one. */
const NON_ADMIN_SESSION: SafeSession = {
  user: { id: 'admin-1', username: 'super_admin', email: 'root@hope.dev', roles: ['SUPER_ADMIN'], tenantId: null },
  isElevated: true,
  workingTenantId: null,
  workingTenantName: null,
  impersonatingUserId: 'doctor2-id',
  impersonatingUsername: 'doctor2',
  effectiveUser: { id: 'doctor2-id', username: 'doctor2', email: 'doctor2@hope.dev', roles: ['DOCTOR'], tenantId: 'ten-1', departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: 'ten-1',
};

const BASE = {
  projectId: null,
  createdAt: '2026-01-05T08:00:00.000Z',
  updatedAt: '2026-06-28T10:00:00.000Z',
  resourceStatus: 'ENABLED' as const,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  createdBy: null,
  updatedBy: null,
};

const TENANT: Tenant = {
  id: 'ten-1',
  ...BASE,
  version: 12,
  name: 'Sunrise Medical Group',
  key: 'sunrise-medical',
  description: 'Multi-clinic group in Da Nang',
  plan: 'ENTERPRISE',
  tags: ['pilot', 'apac'],
};

const EDITABLE_CONFIG: TenantConfig = {
  id: 'cfg-1',
  ...BASE,
  name: 'Session timeout',
  description: 'Idle minutes before members are signed out.',
  key: 'session-timeout-minutes',
  defaultValue: '30',
  value: '45',
  dataType: 'Integer',
  namespace: 'security',
  tenantId: 'ten-1',
  tenantCode: 'sunrise-medical',
  version: 3,
};

const LOCKED_CONFIG: TenantConfig = {
  ...EDITABLE_CONFIG,
  id: 'cfg-2',
  name: 'Data region',
  description: 'Platform-owned residency default.',
  key: 'data-region',
  defaultValue: 'ap-southeast-1',
  value: 'ap-southeast-1',
  dataType: 'String',
  namespace: 'platform',
  locked: true,
  version: 7,
};

/** The synthetic read-only row GET /tenant/me/config appends (id '', version 0). */
const SYNTHETIC_CONFIG: TenantConfig = {
  ...EDITABLE_CONFIG,
  id: '',
  name: 'Enable Local Raw Capture',
  description: 'Server-computed effective flag.',
  key: 'enable-local-raw-capture',
  defaultValue: 'false',
  value: 'true',
  dataType: 'Boolean',
  namespace: 'feature-flags',
  version: 0,
};

const CONFIG_PAGE = { data: [EDITABLE_CONFIG, LOCKED_CONFIG, SYNTHETIC_CONFIG], count: 3, limit: 200, page: 1 };

const ENTITLEMENTS: EntitlementCapabilities = {
  tenantId: 'ten-1',
  plan: 'ENTERPRISE',
  gated: true,
  enforcementEnabled: false,
  quantities: [
    { key: 'users', limit: 25, used: 12, remaining: 13, unlimited: false, nearLimit: false, exceeded: false },
    { key: 'apiKeys', limit: 10, used: 9, remaining: 1, unlimited: false, nearLimit: true, exceeded: false },
    { key: 'departments', limit: null, used: 4, remaining: null, unlimited: true, nearLimit: false, exceeded: false },
    {
      key: 'storageBytes',
      limit: 107_374_182_400,
      used: 32_212_254_720,
      remaining: 75_161_927_680,
      unlimited: false,
      nearLimit: false,
      exceeded: false,
    },
  ],
  meters: [{ key: 'monthlyConsultations', limit: 1000, used: 310, remaining: 690, unlimited: false, nearLimit: false, exceeded: false }],
  features: { dnaReports: true, voiceEnrollment: true, monitoringAccess: false },
  modelTier: 'full',
  rateLimitTier: 'relaxed',
  rateLimitPerMinute: null,
  trial: { isTrial: false, trialEndsAt: null, daysRemaining: null, expired: false },
};

const NO_TENANT_BODY = {
  statusCode: 400,
  message: 'Tenant context is required. Global-admins must use /admin/tenants endpoints to manage other tenants.',
  error: 'Bad Request',
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Handler = (url: string, method: string) => Response | Promise<Response>;

function stubFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return handler(url, method);
    }),
  );
  return calls;
}

/** Force `useViewportTier` to a given tier by stubbing matchMedia (both queries miss → mobile). */
function stubViewport(tier: 'desktop' | 'mobile') {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: tier === 'desktop', // desktop min-width queries match on desktop, miss on mobile
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/** URL-branching happy-path handler; /tenant/me/config must match before /tenant/me. */
function happyHandler(overrides: { tenant?: () => Response; configPatch?: () => Response; session?: SafeSession } = {}): Handler {
  return (url, method) => {
    if (url.includes('/api/auth/session')) return Response.json(overrides.session ?? ELEVATED_SESSION);
    if (url.includes('/tenant/me/config')) {
      if (method === 'PATCH') return (overrides.configPatch ?? (() => Response.json(CONFIG_PAGE)))();
      return Response.json(CONFIG_PAGE);
    }
    if (url.includes('/tenant/me')) return (overrides.tenant ?? (() => Response.json(TENANT)))();
    if (url.includes('/entitlements/me')) return Response.json(ENTITLEMENTS);
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
}

function configGetCalls(calls: RecordedCall[]): number {
  return calls.filter((call) => call.method === 'GET' && call.url.includes('/tenant/me/config')).length;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TenantProfileScreen', () => {
  it('renders the tenant identity on the default Organization tab', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeDefined();

    const identity = await screen.findByRole('region', { name: 'Organization' });
    expect(within(identity).getByText('Sunrise Medical Group')).toBeDefined();
    expect(within(identity).getByText('sunrise-medical')).toBeDefined();
    expect(within(identity).getByText('Enterprise')).toBeDefined();
    expect(within(identity).getByText('Active')).toBeDefined();
    expect(within(identity).getByText('pilot')).toBeDefined();
  });

  it('renders all three profile tabs', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />);
    await screen.findByRole('region', { name: 'Organization' });

    expect(screen.getByRole('tab', { name: 'Organization', selected: true })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Plan & usage' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeDefined();
  });

  it('shows entitlement usage on the Plan & usage tab', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=plan' });

    const plan = await screen.findByRole('region', { name: 'Plan & usage' });
    // Entitlements now fetch only after the session resolves the
    // caller as elevated, so the panel populates one tick later.
    expect(await within(plan).findByText('Users')).toBeDefined();
    expect(within(plan).getByText('12 / 25')).toBeDefined();
    expect(within(plan).getByText('Near limit')).toBeDefined();
    expect(within(plan).getByText('4 / Unlimited')).toBeDefined();
    expect(within(plan).getByText('30 GB / 100 GB')).toBeDefined();
    expect(within(plan).getByText('310 / 1,000')).toBeDefined();
  });

  it('deep-links to the Settings tab via ?tab= and renders the category rail', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    expect(await screen.findByRole('navigation', { name: 'Settings categories' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Settings', selected: true })).toBeDefined();
  });

  it('navigates settings categories and renders the type-aware control for each row', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    await screen.findByRole('navigation', { name: 'Settings categories' });
    // Security category holds the editable integer row → numeric input.
    fireEvent.click(screen.getByRole('button', { name: /Security/ }));
    const input = await screen.findByLabelText('Value for session-timeout-minutes');
    expect((input as HTMLInputElement).value).toBe('45');
    expect((input as HTMLInputElement).inputMode).toBe('decimal');
  });

  it('shows the friendly no-tenant empty state instead of an error for tenant-less global admins', async () => {
    stubFetch(() => Response.json(NO_TENANT_BODY, { status: 400 }));
    renderWithProviders(<TenantProfileScreen />);

    expect(await screen.findByText('No working tenant selected')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });

  it('per-category save sends a per-row If-Match PATCH for each dirty row', async () => {
    const calls = stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    await screen.findByRole('navigation', { name: 'Settings categories' });
    fireEvent.click(screen.getByRole('button', { name: /Security/ }));

    const input = await screen.findByLabelText('Value for session-timeout-minutes');
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe('/api/hope/tenant/me/config');
    expect(patch?.headers.get('if-match')).toBe('"3"');
    expect(patch?.body).toEqual([{ id: 'cfg-1', value: '60', expectedVersion: 3 }]);
  });

  it('surfaces the OCC alert on 412 and Reload latest refetches, keeping the draft', async () => {
    const calls = stubFetch(
      happyHandler({
        configPatch: () => Response.json({ statusCode: 412, message: 'Version drift', error: 'Precondition Failed' }, { status: 412 }),
      }),
    );
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    await screen.findByRole('navigation', { name: 'Settings categories' });
    fireEvent.click(screen.getByRole('button', { name: /Security/ }));
    const input = await screen.findByLabelText('Value for session-timeout-minutes');
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    // Draft is retained (no silent loss).
    expect((screen.getByLabelText('Value for session-timeout-minutes') as HTMLInputElement).value).toBe('60');

    const before = configGetCalls(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(configGetCalls(calls)).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText(/412 Precondition Failed/)).toBeNull());
  });

  it('locked and synthetic read-only rows cannot be edited', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    await screen.findByRole('navigation', { name: 'Settings categories' });
    // Locked row lives under Data & residency.
    fireEvent.click(screen.getByRole('button', { name: /Data & residency/ }));
    const locked = await screen.findByLabelText('Value for data-region');
    expect((locked as HTMLInputElement).disabled).toBe(true);

    // Synthetic boolean row lives under Clinical defaults (rendered as a Switch).
    fireEvent.click(screen.getByRole('button', { name: /Clinical defaults/ }));
    const synthetic = await screen.findByLabelText('Value for enable-local-raw-capture');
    expect((synthetic as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the settings category rail as a horizontal chip scroll on mobile', async () => {
    stubViewport('mobile');
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

    const rail = await screen.findByRole('navigation', { name: 'Settings categories' });
    expect(rail.className).toContain('overflow-x-auto');
  });

  it('mirrors the loaded layout with skeletons while the profile is in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container } = renderWithProviders(<TenantProfileScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Organization' })).toBeNull();
  });

  it('surfaces a block error with retry when tenant/me fails unexpectedly', async () => {
    let tenantAttempts = 0;
    stubFetch(
      happyHandler({
        tenant: () => {
          tenantAttempts += 1;
          return tenantAttempts === 1 ? Response.json({ message: 'upstream down' }, { status: 503 }) : Response.json(TENANT);
        },
      }),
    );
    renderWithProviders(<TenantProfileScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('upstream down')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect((await screen.findAllByText('Sunrise Medical Group')).length).toBeGreaterThan(0);
  });

  /**
   * While impersonating (or for a real end-user), the
   * screen must show only basic org identity + a read-only Settings tab;
   * "Plan & usage" (limits/meters/entitlements) must not render or fetch.
   */
  describe('non-elevated / impersonated session', () => {
    it('hides the Plan & usage tab and never fetches entitlements', async () => {
      const calls = stubFetch(happyHandler({ session: NON_ADMIN_SESSION }));
      renderWithProviders(<TenantProfileScreen />);

      await screen.findByRole('region', { name: 'Organization' });
      expect(screen.queryByRole('tab', { name: 'Plan & usage' })).toBeNull();
      expect(calls.some((call) => call.url.includes('/entitlements/me'))).toBe(false);
    });

    it('shows only the organization name and status, hiding key/plan/description/tags/timestamps', async () => {
      stubFetch(happyHandler({ session: NON_ADMIN_SESSION }));
      renderWithProviders(<TenantProfileScreen />);

      const identity = await screen.findByRole('region', { name: 'Organization' });
      expect(within(identity).getByText('Sunrise Medical Group')).toBeDefined();
      expect(within(identity).getByText('Active')).toBeDefined();
      expect(within(identity).queryByText('sunrise-medical')).toBeNull();
      expect(within(identity).queryByText('Enterprise')).toBeNull();
      expect(within(identity).queryByText('Multi-clinic group in Da Nang')).toBeNull();
      expect(within(identity).queryByText('pilot')).toBeNull();
    });

    it('keeps the Settings tab, read-only (no Save bar even after an edit)', async () => {
      stubFetch(happyHandler({ session: NON_ADMIN_SESSION }));
      renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

      await screen.findByRole('navigation', { name: 'Settings categories' });
      expect(screen.getByRole('tab', { name: 'Settings', selected: true })).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: /Security/ }));
      const input = await screen.findByLabelText('Value for session-timeout-minutes');
      expect((input as HTMLInputElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: '60' } });
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('keeps the full admin view for an elevated session (regression)', async () => {
      stubFetch(happyHandler({ session: ELEVATED_SESSION }));
      renderWithProviders(<TenantProfileScreen />);

      const identity = await screen.findByRole('region', { name: 'Organization' });
      expect(within(identity).getByText('sunrise-medical')).toBeDefined();
      expect(screen.getByRole('tab', { name: 'Plan & usage' })).toBeDefined();
    });
  });
});
