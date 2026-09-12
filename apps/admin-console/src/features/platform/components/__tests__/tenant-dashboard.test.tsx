/**
 * TASK-954 — the Tenant Dashboard a non-elevated session gets at `/dashboard`.
 *
 * Every region reads something the gateway already serves a tenant admin,
 * scoped to its own tenant; nothing on it reads the `manage:PlatformMetrics`
 * platform-wide routes. The audit card carries no "Audit Logs" link, because
 * `/audit-logs` is a tier-10-19 screen a tenant admin cannot open.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { TenantDashboard } from '../tenant-dashboard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TENANT_ID = 'tnt-1';

/** A tenant admin: never a working tenant, always its own tenant as the effective scope. */
const TENANT_SESSION = {
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: TENANT_ID },
  isElevated: false,
  workingTenantId: null,
  workingTenantName: null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: TENANT_ID, departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: TENANT_ID,
};

const USAGE = {
  totalUsers: 21,
  totalDepartments: 8,
  totalPromptTemplates: 37,
  totalPipelines: 0,
  storageUsedBytes: 14_000_000,
  storageQuotaBytes: 5_000_000_000,
  transcriptionMinutes: 9.58,
  summaries24h: 3,
  totalConsultations: 9,
};

const HEALTH = {
  status: 'degraded',
  timestamp: new Date().toISOString(),
  services: {
    text: { status: 'healthy', service: 'Text', duration_ms: 42 },
    harness: { status: 'down', service: 'Clinical Documentation Harness', error: 'ECONNREFUSED' },
  },
};

const AUDIT = {
  data: [
    {
      id: 'al_1',
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      action: 'UPDATE',
      eventType: 'department.update',
      resourceType: 'DEPARTMENT',
      resourceId: 'dept_gen',
      responsibleUser: { id: 'u-1', displayName: 'ArcaAI Administrator', email: 'admin@arca.ai' },
    },
  ],
  count: 1,
  limit: 10,
  page: 0,
};

type RouteOverrides = Partial<Record<'usage' | 'health' | 'audit' | 'tenants', () => Response>>;

function installFetch(overrides: RouteOverrides = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/auth/session') return Response.json(TENANT_SESSION);
    if (url.includes(`admin/tenants/${TENANT_ID}/usage`)) return (overrides.usage ?? (() => Response.json(USAGE)))();
    if (url.includes('admin/tenants')) {
      return (overrides.tenants ?? (() => Response.json({ data: [{ id: TENANT_ID, name: 'ArcaAI', key: 'ARCAAI' }], count: 1, limit: 500, page: 0 })))();
    }
    if (url.includes('admin/health/services')) return (overrides.health ?? (() => Response.json(HEALTH)))();
    if (url.includes('admin/audit-logs')) return (overrides.audit ?? (() => Response.json(AUDIT)))();
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof installFetch>, fragment: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

describe('TenantDashboard', () => {
  it('renders the tenant usage tiles, named after the caller’s own tenant', async () => {
    const fetchMock = installFetch();
    renderWithProviders(<TenantDashboard />);

    expect(screen.getByRole('heading', { level: 1, name: 'Tenant Dashboard' })).toBeDefined();
    expect(await screen.findByText('ArcaAI')).toBeDefined();

    const stats = await screen.findByRole('region', { name: /key metrics/i });
    expect(await within(stats).findByText('9')).toBeDefined();
    expect(within(stats).getByText('Consultations')).toBeDefined();
    expect(within(stats).getByText('9.58')).toBeDefined();
    expect(within(stats).getByText('Transcription minutes')).toBeDefined();
    expect(within(stats).getByText('3')).toBeDefined();
    expect(within(stats).getByText('Summaries (24h)')).toBeDefined();
    expect(within(stats).getByText('Storage used')).toBeDefined();
    // The quota rides along as the tile hint ("of <quota>"), never as a bare number.
    expect(within(stats).getByText(/^of /)).toBeDefined();

    // The usage read is the caller's OWN tenant, and nothing platform-wide is ever requested.
    await waitFor(() => expect(callsTo(fetchMock, `admin/tenants/${TENANT_ID}/usage`)).toBeGreaterThan(0));
    expect(callsTo(fetchMock, 'admin/platform/')).toBe(0);
  });

  it('renders the footprint card, the services strip and the recent activity without an audit-logs link', async () => {
    installFetch();
    renderWithProviders(<TenantDashboard />);

    const heading = await screen.findByRole('heading', { name: 'Tenant footprint' });
    const footprint = heading.closest('[data-slot="card"]') as HTMLElement;
    expect(await within(footprint).findByText('Users')).toBeDefined();
    expect(within(footprint).getByText('21')).toBeDefined();
    expect(within(footprint).getByText('Departments')).toBeDefined();
    expect(within(footprint).getByText('8')).toBeDefined();
    expect(within(footprint).getByText('Prompt templates')).toBeDefined();
    expect(within(footprint).getByText('37')).toBeDefined();

    expect((await screen.findAllByText('Text')).length).toBeGreaterThan(0);
    expect(screen.getByText('(down · ECONNREFUSED)')).toBeDefined();

    expect(await screen.findByText('department.update')).toBeDefined();
    expect(screen.getByText('admin@arca.ai')).toBeDefined();
    // `/audit-logs` is tier 10-19 — a tenant admin gets no link into a 404.
    expect(screen.queryByRole('link', { name: /audit logs/i })).toBeNull();
  });

  it('surfaces a block error with retry when the usage read fails', async () => {
    let attempts = 0;
    installFetch({
      usage: () => {
        attempts += 1;
        return attempts === 1 ? Response.json({ message: 'usage unavailable' }, { status: 503 }) : Response.json(USAGE);
      },
    });
    renderWithProviders(<TenantDashboard />);

    const stats = await screen.findByRole('region', { name: /key metrics/i });
    expect(await within(stats).findByText('usage unavailable')).toBeDefined();
  });

  it('has no axe violations', async () => {
    installFetch();
    const { container } = renderWithProviders(<TenantDashboard />);
    await screen.findByText('department.update');
    await screen.findByText('21');
    expect(await axe(container)).toHaveNoViolations();
  });
});
