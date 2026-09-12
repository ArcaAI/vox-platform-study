/**
 * TDD screen tests for frame 25 (tenant half — Tenant profile),
 * redesign: two tabs (Organization identity from GET /tenants/me, Plan & usage
 * from GET /tenants/me/entitlements) and the frame's NoTenant variant for
 * tenant-less super admins.
 *
 * TASK-956 — the former Settings tab was a THIRD editor over the same
 * `GlobalSetting` rows that `/settings` (rows & secrets) and `/settings-registry`
 * (governed keys) already own. One authoritative editor per backend resource
 * (rule 13), so the tab is gone: the Organization tab carries a read-only pointer
 * with plain-href deep links to the two owners, gated on the caller's
 * `GlobalSetting` abilities, and the screen never reads `tenants/me/config`.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { Tenant } from '@/features/tenants/api/types';
import type { PermissionRule, SafeSession } from '@/shared/auth';
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

const MANAGE_ALL: PermissionRule[] = [{ action: 'manage', subject: 'all' }];
const READ_SETTINGS_ONLY: PermissionRule[] = [{ action: 'read', subject: 'GlobalSetting' }];
const NO_SETTINGS_ABILITY: PermissionRule[] = [{ action: 'read', subject: 'Consultation' }];

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
  features: { platformDefaultCredential: false, paletteStt: true, agenticLoop: true },
  modelTier: 'full',
  rateLimitTier: 'relaxed',
  rateLimitPerMinute: null,
  trial: { isTrial: false, trialEndsAt: null, daysRemaining: null, expired: false },
};

const NO_TENANT_BODY = {
  statusCode: 400,
  message: 'Tenant context is required. Super-admins must use /admin/tenants endpoints to manage other tenants.',
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

/**
 * URL-branching happy-path handler; the deeper /tenants/me/* leaves must match
 * before the bare /tenants/me. There is deliberately NO `/tenants/me/config`
 * branch: the screen no longer reads it, and a stray read fails the test.
 */
function happyHandler(overrides: { tenant?: () => Response; session?: SafeSession; permissions?: PermissionRule[] } = {}): Handler {
  return (url, method) => {
    if (url.includes('/api/auth/session')) return Response.json(overrides.session ?? ELEVATED_SESSION);
    if (url.includes('/users/me/permission-checks')) {
      return Response.json({ userId: 'admin-1', tenantId: 'ten-1', permissions: overrides.permissions ?? MANAGE_ALL });
    }
    if (url.includes('/tenants/me/entitlements')) return Response.json(ENTITLEMENTS);
    if (url.includes('/tenants/me')) return (overrides.tenant ?? (() => Response.json(TENANT)))();
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
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

  it('renders the two profile tabs and no Settings tab', async () => {
    stubFetch(happyHandler());
    renderWithProviders(<TenantProfileScreen />);
    await screen.findByRole('region', { name: 'Organization' });

    expect(screen.getByRole('tab', { name: 'Organization', selected: true })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Plan & usage' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
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

  describe('settings pointer (TASK-956 — one authoritative editor per resource)', () => {
    it('points at both settings editors from the Organization tab and never reads tenants/me/config', async () => {
      const calls = stubFetch(happyHandler());
      renderWithProviders(<TenantProfileScreen />);

      const pointer = await screen.findByRole('region', { name: 'Settings' });
      const rows = within(pointer).getByRole('link', { name: /Settings rows & secrets/ });
      const registry = within(pointer).getByRole('link', { name: /Settings registry/ });
      expect(rows.getAttribute('href')).toBe('/settings');
      expect(registry.getAttribute('href')).toBe('/settings-registry');

      // No value, no control, no save bar — the pointer is not an editor.
      expect(within(pointer).queryByRole('textbox')).toBeNull();
      expect(within(pointer).queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(calls.some((call) => call.url.includes('/tenants/me/config'))).toBe(false);
    });

    it('offers only the registry link to a caller who may read but not manage settings', async () => {
      stubFetch(happyHandler({ permissions: READ_SETTINGS_ONLY }));
      renderWithProviders(<TenantProfileScreen />);

      const pointer = await screen.findByRole('region', { name: 'Settings' });
      expect(await within(pointer).findByRole('link', { name: /Settings registry/ })).toBeDefined();
      expect(within(pointer).queryByRole('link', { name: /Settings rows & secrets/ })).toBeNull();
    });

    it('hides the pointer entirely from a caller without GlobalSetting abilities', async () => {
      const calls = stubFetch(happyHandler({ permissions: NO_SETTINGS_ABILITY }));
      renderWithProviders(<TenantProfileScreen />);

      await screen.findByRole('region', { name: 'Organization' });
      // The pointer decides after the permission read has answered.
      await waitFor(() => expect(calls.some((call) => call.url.includes('/users/me/permission-checks'))).toBe(true));
      expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull();
      expect(screen.queryByRole('link', { name: /Settings registry/ })).toBeNull();
    });

    it('sends the retired ?tab=settings deep link to the Organization tab', async () => {
      stubFetch(happyHandler());
      renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

      await screen.findByRole('region', { name: 'Organization' });
      expect(screen.getByRole('tab', { name: 'Organization', selected: true })).toBeDefined();
      expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
      expect(screen.queryByRole('navigation', { name: 'Settings categories' })).toBeNull();
    });
  });

  it('shows the friendly no-tenant empty state instead of an error for tenant-less super admins', async () => {
    stubFetch(() => Response.json(NO_TENANT_BODY, { status: 400 }));
    renderWithProviders(<TenantProfileScreen />);

    expect(await screen.findByText('No working tenant selected')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Plan & usage' })).toBeNull();
  });

  it('mirrors the loaded layout with skeletons while the profile is in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container } = renderWithProviders(<TenantProfileScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Organization' })).toBeNull();
  });

  it('surfaces a block error with retry when tenants/me fails unexpectedly', async () => {
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
   * screen must show only basic org identity; "Plan & usage"
   * (limits/meters/entitlements) must not render or fetch.
   */
  describe('non-elevated / impersonated session', () => {
    it('hides the Plan & usage tab and never fetches entitlements', async () => {
      const calls = stubFetch(happyHandler({ session: NON_ADMIN_SESSION, permissions: NO_SETTINGS_ABILITY }));
      renderWithProviders(<TenantProfileScreen />);

      await screen.findByRole('region', { name: 'Organization' });
      expect(screen.queryByRole('tab', { name: 'Plan & usage' })).toBeNull();
      expect(calls.some((call) => call.url.includes('/tenants/me/entitlements'))).toBe(false);
    });

    it('shows only the organization name and status, hiding key/plan/description/tags/timestamps', async () => {
      stubFetch(happyHandler({ session: NON_ADMIN_SESSION, permissions: NO_SETTINGS_ABILITY }));
      renderWithProviders(<TenantProfileScreen />);

      const identity = await screen.findByRole('region', { name: 'Organization' });
      expect(within(identity).getByText('Sunrise Medical Group')).toBeDefined();
      expect(within(identity).getByText('Active')).toBeDefined();
      expect(within(identity).queryByText('sunrise-medical')).toBeNull();
      expect(within(identity).queryByText('Enterprise')).toBeNull();
      expect(within(identity).queryByText('Multi-clinic group in Da Nang')).toBeNull();
      expect(within(identity).queryByText('pilot')).toBeNull();
    });

    it('has no Settings tab and, without GlobalSetting abilities, no settings pointer either', async () => {
      stubFetch(happyHandler({ session: NON_ADMIN_SESSION, permissions: NO_SETTINGS_ABILITY }));
      renderWithProviders(<TenantProfileScreen />, { searchParams: '?tab=settings' });

      await screen.findByRole('region', { name: 'Organization' });
      expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull();
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
