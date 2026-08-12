/**
 * AgenticProvider — consultation context schema discovery (TASK-665).
 *
 * TDD coverage this file owns:
 *  - The schema fetch happens once at mount, cached exactly like
 *    `modelRegistry.loadTenantConfig()` (DEF-H5's sibling guarantee), and is
 *    resolved BEFORE `configReady` flips true.
 *  - "The session keeps its pinned version when the tenant publishes a new
 *    one": the provider does NOT re-fetch mid-session — `consultationSchema`
 *    stays exactly what mount resolved until an explicit tenant switch.
 *  - The fetch is REPLICATED on a same-tab tenant switch (not just mount):
 *    the outgoing tenant's schema is cleared synchronously, and the
 *    incoming tenant's own bundle is fetched and applied.
 *
 * Modeled on `AgenticProvider.tenant-switch.task317.test.ts` (same render
 * rig, same fetch-handler-by-URL pattern).
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
let contextSchemaCallCount: number;

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  contextSchemaCallCount = 0;
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
const TENANT_B = 'tenant-2';
const USER_B = 'user-99';

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

/** Bundles a `/tenant/me/context-schema` response for a given tenant + a small `meHandler`-shaped router. */
function handlerFor(me: { id?: string; tenantId?: string; departmentId?: string }, schemaVersionByTenant: Record<string, string>): FetchHandler {
  return async (url) => {
    if (url.endsWith('/auth/me')) return jsonResponse(me);
    if (url.includes('/tenant/me/context-schema')) {
      contextSchemaCallCount += 1;
      const tenantId = me.tenantId ?? TENANT_A;
      const versionId = schemaVersionByTenant[tenantId];
      if (!versionId) return jsonResponse({ etag: 'none' });
      return jsonResponse({
        schemaId: `schema-${tenantId}`,
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

describe('AgenticProvider — consultation context schema discovery (TASK-665)', () => {
  it('fetches the schema once at mount and resolves it BEFORE configReady flips', async () => {
    handler = handlerFor({ id: USER_A, tenantId: TENANT_A }, { [TENANT_A]: 'version-A1' });

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('version-A1');
    expect(contextSchemaCallCount).toBe(1);
  });

  it('TDD: the session keeps its pinned version when the tenant "publishes a new one" mid-session (no re-fetch without a switch)', async () => {
    handler = handlerFor({ id: USER_A, tenantId: TENANT_A }, { [TENANT_A]: 'version-A1' });

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('version-A1');

    // The tenant publishes a NEW version server-side — subsequent requests
    // for THIS session must still see the version pinned at mount, because
    // nothing here triggers a re-fetch (no tenant/user switch occurred).
    handler = handlerFor({ id: USER_A, tenantId: TENANT_A }, { [TENANT_A]: 'version-A2-published-later' });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('version-A1');
    expect(contextSchemaCallCount).toBe(1);
  });

  it('TDD: is REPLICATED on a same-tab tenant switch — cleared synchronously, then re-fetched for the incoming tenant', async () => {
    handler = handlerFor({ id: USER_A, tenantId: TENANT_A }, { [TENANT_A]: 'version-A1' });

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('version-A1');
    expect(contextSchemaCallCount).toBe(1);

    handler = handlerFor({ id: USER_B, tenantId: TENANT_B }, { [TENANT_B]: 'version-B1' });

    act(() => {
      store.getState().setImpersonatedUser({ id: USER_B, tenantId: TENANT_B });
    });

    // Synchronous assertion: `clearTenantSessionData()` nulls the outgoing
    // tenant's schema BEFORE the async re-hydrate tail resolves tenant B's.
    expect(store.getState().consultationSchema).toBeNull();

    await waitFor(() => expect(store.getState().consultationSchema?.contextSchemaVersionId).toBe('version-B1'), { timeout: 2000 });
    expect(contextSchemaCallCount).toBe(2);
  });
});
