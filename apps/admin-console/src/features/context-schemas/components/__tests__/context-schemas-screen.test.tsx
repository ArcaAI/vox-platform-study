/**
 * Context Schemas CATALOG — fetch is stubbed at the network boundary. Covers the
 * working-tenant gate, the empty state, and the row that now navigates to the
 * schema's own page instead of opening a drawer.
 *
 * Everything about ONE schema — the definition editor, publish, versions, delete
 * — lives in `context-schema-detail-screen.test.tsx`, because it lives on its
 * own route.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ConsultationContextSchema } from '../../api/types';
import { ContextSchemasScreen } from '../context-schemas-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Creating a schema pushes to its new page; there is no app router under the test harness.
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return { ...actual, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }) };
});

function schema(overrides: Partial<ConsultationContextSchema> = {}): ConsultationContextSchema {
  return {
    id: 's-1',
    tenantId: 'tnt-1',
    slug: 'general_medicine',
    name: 'General Medicine Context',
    description: null,
    scope: 'TENANT',
    departmentId: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: false,
    sourceTemplateSlug: null,
    templateLocked: false,
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function session(overrides: Partial<{ workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function baseHandler(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/departments') return Response.json([]);
  if (path.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  return undefined;
}

function stubScreen(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? baseHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('ContextSchemasScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/consultation-context-schemas'))).toBe(true);
  });

  it('lands on the Context Schemas catalog with an empty state when there are none', async () => {
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Context Schemas' })).toBeDefined();
    expect(await screen.findByText('No context schemas yet')).toBeDefined();
  });

  it('links each row to the schema page rather than opening a drawer', async () => {
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    const row = await screen.findByRole('link', { name: /General Medicine Context/ });
    expect(row.getAttribute('href')).toBe('/context-schemas/s-1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no axe violations in either theme', async () => {
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      return undefined;
    });
    const { container } = renderWithProviders(<ContextSchemasScreen />);
    await screen.findByText('General Medicine Context');
    expect(await axe(container)).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      return undefined;
    });
    const dark = renderWithProviders(<ContextSchemasScreen />);
    await screen.findByText('General Medicine Context');
    expect(await axe(dark.container)).toHaveNoViolations();
  });
});
