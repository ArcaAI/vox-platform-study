/**
 * Frame 32 — Agent Catalog screen. fetch is stubbed at the network boundary;
 * assertions cover the working-tenant gate, the `DepartmentAgent` catalog and
 * the deep link to the prompt-template surface.
 *
 * The template-grid, detail-drawer and governance cases that used to live here
 * moved to `prompt-templates-screen.test.tsx` when `PromptTemplate` got its own
 * route (TASK-634 R6) — this screen no longer renders them.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Department, PromptTemplate, PromptUsageAnalytics, PromptVersion } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    description: 'SOAP output for cardiology consults',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'PUBLISHED',
    currentVersionNumber: 7,
    departmentId: 'd-1',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 7,
    ...overrides,
  };
}

const TEMPLATES: PromptTemplate[] = [
  template(),
  template({ id: 'pt-2', name: 'Discharge Summary', departmentId: undefined, currentVersionNumber: 12, version: 3 }),
  template({ id: 'pt-3', name: 'Radiology Report', departmentId: 'd-2', currentVersionNumber: 4, status: 'DRAFT', version: 2 }),
];

const DEPARTMENTS: Department[] = [
  {
    id: 'd-1',
    code: 'CARD',
    name: 'Cardiology',
    isRootDepartment: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 3,
  },
  {
    id: 'd-2',
    code: 'RADIO',
    name: 'Radiology',
    isRootDepartment: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 5,
  },
];

function version(templateId: string, versionNumber: number, overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: `pv-${templateId}-${versionNumber}`,
    promptTemplateId: templateId,
    versionNumber,
    content: `Prompt body v${versionNumber}`,
    changedBy: 'taphuynh',
    createdAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

const VERSIONS: Record<string, PromptVersion[]> = {
  'pt-1': [
    version('pt-1', 7, { createdAt: '2026-07-02T10:00:00.000Z' }),
    version('pt-1', 6, { changedBy: 'minh.tran' }),
    version('pt-1', 5),
    version('pt-1', 4, { changedBy: 'dr.lee' }),
  ],
  'pt-2': [version('pt-2', 12, { changedBy: 'minh.tran' }), version('pt-2', 11)],
  'pt-3': [version('pt-3', 4)],
};

const ANALYTICS: PromptUsageAnalytics = {
  totalUsages: 1204,
  byDepartment: [{ departmentId: 'd-1', count: 1204 }],
  byDoctor: [{ doctorId: 'doc-1', count: 1204 }],
  byDay: [{ day: new Date().toISOString().slice(0, 10), count: 42 }],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
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
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
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
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  // WorkingTenantGate now reads the effective identity; mirror the
  // (possibly overridden) operator fields since these fixtures never impersonate.
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  if (call.method !== 'GET') return undefined;
  const path = new URL(call.url, 'http://test.local').pathname;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
  // The Agents tab (TASK-547, default landing) — empty by default so the
  // Agent Templates-tab tests below (which stay unaffected by this ticket)
  // don't need to know about it.
  if (path === '/api/hope/admin/department-agents') return Response.json({ data: [], count: 0, limit: 200, page: 0 });
  if (path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: TEMPLATES, count: TEMPLATES.length, limit: 10, page: 1 });
  }
  if (path === '/api/hope/admin/prompt-templates/analytics/usage') return Response.json(ANALYTICS);
  if (path === '/api/hope/admin/prompt-templates/usage-records') {
    return Response.json({
      data: [{ id: 'ur-1', promptTemplateId: 'pt-1', promptVersionNumber: 7, createdAt: '2026-07-01T09:00:00.000Z' }],
      count: 1,
      limit: 5,
      page: 0,
    });
  }
  const detail = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)$/);
  if (detail) {
    const row = TEMPLATES.find((entry) => entry.id === detail[1]);
    return row ? Response.json(row, { headers: { etag: `"${row.version}"` } }) : undefined;
  }
  const versions = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/versions$/);
  if (versions) return Response.json(VERSIONS[versions[1]] ?? []);
  const usage = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/usage$/);
  if (usage) return Response.json({ totalUsages: usage[1] === 'pt-1' ? 1204 : 64, lastUsedAt: '2026-07-01T09:00:00.000Z' });
  const diff = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/versions\/(\d+)\/diff\/(\d+)$/);
  if (diff) {
    return Response.json({
      promptTemplateId: diff[1],
      fromVersion: Number(diff[2]),
      toVersion: Number(diff[3]),
      fields: [],
      changes: [
        { value: 'You are a clinical scribe.\n', count: 1 },
        { value: 'Be brief.\n', removed: true, count: 1 },
        { value: 'Be thorough and structured.\n', added: true, count: 1 },
      ],
      patch: '@@ -1,2 +1,2 @@',
      stats: { additions: 1, deletions: 1, unchanged: 1 },
    });
  }
  return undefined;
}

/** Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved layout in tests. */
function settingsResponse(call: RecordedCall): Response | undefined {
  if (!call.url.includes('/user/me/settings')) return undefined;
  return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubAgents(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => settingsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('AgentsScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubAgents((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<AgentsScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/prompt-templates'))).toBe(true);
  });

  it('lands on the Agent Catalog with the DepartmentAgent tab and no template grid', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Agent Catalog' })).toBeDefined();
    // The PromptTemplate grid and governance surface moved to
    // `/prompt-templates`; this screen owns DepartmentAgent alone.
    expect(screen.queryByRole('tab', { name: 'Agent Templates' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Governance' })).toBeNull();
    expect(screen.queryByText('Cardiology Notes')).toBeNull();
  });

  it('deep-links to the prompt-template surface instead of editing templates here', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />);

    const link = await screen.findByRole('link', { name: 'Open prompt templates' });
    expect(link.getAttribute('href')).toBe('/prompt-templates');
  });
});
