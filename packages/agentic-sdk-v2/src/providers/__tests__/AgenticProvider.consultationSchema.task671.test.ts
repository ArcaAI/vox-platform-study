/**
 * AgenticProvider — department-scoped consultation context schema discovery
 * (deferred from).
 *
 * Wired the tenant-scoped default fetch only, because
 * `me.departmentId` isn't known until `/auth/me` resolves INSIDE `init()`,
 * while the schema fetch is kicked off EAGERLY before `init()` runs (to
 * cover the no-credentials path). This file proves the follow-up: once
 * `me.departmentId` is known, the provider prefers a department-scoped
 * bundle — via a SECOND, department-scoped fetch that supersedes the
 * eager tenant-scoped one — and replicates the same preference in the
 * same-tab tenant-switch rehydrate effect.
 *
 * Modeled on `AgenticProvider.consultationSchema.task665.test.ts` (same
 * render rig, same fetch-handler-by-URL pattern).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { AgenticProvider } from '../AgenticProvider';
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig } from '../../types';

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

const idbStore = new Map<string, unknown>();

vi.mock('../../core/configDB', () => ({
  ARCAAI_CONFIG_DB_NAME: 'arcaai-config',
  ARCAAI_CONFIG_DB_VERSION: 3,
  USER_PREFERENCES_STORE: 'user-preferences',
  PERSONALIZATION_STORE: 'personalization',
  LEGACY_PERSONALIZATION_GLOBAL_KEY: 'arcaai-personalization',
  openConfigDB: vi.fn(),
  applyConfigDBUpgrade: vi.fn(),
  configDBGet: vi.fn(async (_store: string, key: string) => idbStore.get(key)),
  configDBSet: vi.fn(async (_store: string, key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  configDBDelete: vi.fn(async (_store: string, key: string) => {
    idbStore.delete(key);
  }),
  configDBClear: vi.fn(async () => {
    idbStore.clear();
  }),
}));

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchSpy: ReturnType<typeof vi.fn>;
let handler: FetchHandler;
let contextSchemaCalls: string[];

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  contextSchemaCalls = [];
  fetchSpy = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return handler(u);
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  idbStore.clear();
  localStorage.clear();
});

const TENANT_A = 'tenant-1';
const USER_A = 'user-77';
const DEPT_A = 'dept-cardiology';
const TENANT_B = 'tenant-2';
const USER_B = 'user-99';
const DEPT_B = 'dept-oncology';

function renderProvider() {
  const captured: { api: AgenticStoreApi | null } = { api: null };
  const Capture: React.FC = () => {
    captured.api = useStoreApi();
    return null;
  };

  const config: AgenticConfig = {
    api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: TENANT_A },
    personalization: { storage: 'local' },
  };
  render(React.createElement(AgenticProvider, { config, children: React.createElement(Capture) }));
  if (!captured.api) throw new Error('AgenticProvider store API was not captured');
  return captured.api;
}

/**
 * Router serving `/auth/me`, `/tenant/me/config`, and
 * `/tenant/me/context-schema` — the latter branching on whether the request
 * carries `?departmentId=`, returning a DIFFERENT `contextSchemaVersionId`
 * for the department-scoped vs. tenant-scoped bundle so tests can assert
 * which one won.
 */
function handlerFor(
  me: { id?: string; tenantId?: string; departmentId?: string },
  versions: { tenant?: string; department?: string },
): FetchHandler {
  return async (url) => {
    if (url.endsWith('/auth/me')) return jsonResponse(me);
    if (url.includes('/tenant/me/context-schema')) {
      contextSchemaCalls.push(url);
      const isDepartmentScoped = url.includes('departmentId=');
      const versionId = isDepartmentScoped ? versions.department : versions.tenant;
      if (!versionId) return jsonResponse({ etag: 'none' });
      return jsonResponse({
        schemaId: `schema-${versionId}`,
        slug: 'default',
        name: 'Default',
        versionNumber: 1,
        contextSchemaVersionId: versionId,
        checksum: 'x',
        definition: { schemaVersion: '1.0', kinds: [{ key: 'note', label: 'Note', primitive: 'TEXT' }] },
        etag: `"${versionId}"`,
      });
    }
    if (url.includes('/tenant/me/config')) return jsonResponse({ defaultSttModel: null, features: {} });
    return jsonResponse({});
  };
}

describe('AgenticProvider — department-scoped consultation context schema discovery', () => {
  it('prefers the DEPARTMENT-scoped bundle when a department is known at mount', async () => {
    handler = handlerFor(
      { id: USER_A, tenantId: TENANT_A, departmentId: DEPT_A },
      { tenant: 'tenant-version', department: 'department-version' },
    );

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    // The department-scoped bundle wins — not the tenant-scoped default that
    // was kicked off eagerly (before `me.departmentId` was known).
    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('department-version');

    // Both the eager tenant-scoped fetch AND the department-scoped re-fetch
    // hit the endpoint; exactly one of the two calls carries `departmentId`.
    expect(contextSchemaCalls).toHaveLength(2);
    expect(contextSchemaCalls.some((u) => u.includes(`departmentId=${DEPT_A}`))).toBe(true);
    expect(contextSchemaCalls.some((u) => !u.includes('departmentId='))).toBe(true);
  });

  it('falls back to the TENANT-scoped bundle when no department is known', async () => {
    handler = handlerFor({ id: USER_A, tenantId: TENANT_A }, { tenant: 'tenant-only-version' });

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('tenant-only-version');
    // No department known — only the single tenant-scoped fetch happens.
    expect(contextSchemaCalls).toHaveLength(1);
    expect(contextSchemaCalls[0]).not.toContain('departmentId=');
  });

  it('re-resolves department scope on a same-tab tenant switch', async () => {
    handler = handlerFor(
      { id: USER_A, tenantId: TENANT_A, departmentId: DEPT_A },
      { tenant: 'A-tenant-version', department: 'A-department-version' },
    );

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('A-department-version');

    contextSchemaCalls = [];
    handler = handlerFor(
      { id: USER_B, tenantId: TENANT_B, departmentId: DEPT_B },
      { tenant: 'B-tenant-version', department: 'B-department-version' },
    );

    act(() => {
      store.getState().setImpersonatedUser({ id: USER_B, tenantId: TENANT_B, departmentId: DEPT_B });
    });

    // `clearTenantSessionData()` nulls the outgoing tenant's schema
    // synchronously before the async re-hydrate tail resolves tenant B's.
    expect(store.getState().consultationSchema).toBeNull();

    await waitFor(() => expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('B-department-version'), {
      timeout: 2000,
    });

    // The tenant-switch path already knows `effectiveDepartmentId` up front
    // (unlike mount), so it issues a SINGLE, already department-scoped fetch.
    expect(contextSchemaCalls).toHaveLength(1);
    expect(contextSchemaCalls[0]).toContain(`departmentId=${DEPT_B}`);
  });
});
