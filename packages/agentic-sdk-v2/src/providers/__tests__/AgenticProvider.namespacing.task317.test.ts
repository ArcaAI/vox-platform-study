/**
 * TASK-317 W1.2 (AC-1 / AC-4) — AgenticProvider namespace wiring.
 *
 * Review finding C-1: the provider constructed PersonalizationManager and
 * ModelRegistry up-front with `userId = null`, so their storage keys collapsed
 * to the constant `pre-login` namespace and were captured BY VALUE in the ctor
 * (`PersonalizationManager.cacheKey`, `ModelRegistry.selectedModelsStorageKey`).
 * After `/auth/me` resolved the real `${tenantId}::${userId}` the two managers
 * were never re-keyed, so every user on an origin shared
 * `arcaai-personalization/pre-login` + `arcaai-selected-models/pre-login`
 * (AC-1 / AC-4 not actually met — a default-config cross-user leak: with
 * `storage: 'local'` the pre-login IDB cache is authoritative, so user B
 * hydrates user A's personalization).
 *
 * These tests drive the REAL managers through the provider (mount → /auth/me →
 * tenant/user switch) and assert the browser-storage keys track the
 * authenticated namespace. The W1 unit tests construct managers with explicit
 * namespaces, so they never exercised this provider wiring.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';

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

// In-memory IDB so we can observe the personalization cache *key* the manager
// actually writes/reads (mirrors the W1 unit-test mock; keyed by row key).
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;
let handler: FetchHandler;

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
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

const TENANT = 'tenant-1';
const USER = 'user-77';
const NS = `${TENANT}::${USER}`;

async function renderProvider(configOverride: Record<string, unknown> = {}) {
  const { AgenticProvider } = await import('../AgenticProvider');
  const { useAgenticStore } = await import('../../store/agenticStore');

  // Clean store snapshot. clearOnLogout takes the outgoing namespace (W1.4).
  useAgenticStore.getState().clearOnLogout('pre-login');

  const child = React.createElement('div', null, 'child');
  const element = React.createElement(
    AgenticProvider,
    {
      config: {
        api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: TENANT },
        audio: undefined,
        personalization: { storage: 'local' },
        ...configOverride,
      },
    } as never,
    child,
  );
  render(element);
  return useAgenticStore;
}

function meHandler(me: { id?: string; tenantId?: string; departmentId?: string }): FetchHandler {
  return async (url) => {
    if (url.endsWith('/auth/me')) return jsonResponse(me);
    // Array-less payload → parseTenantConfig yields no defaultSttModel, so the
    // registry does NOT auto-select/persist at mount (keeps pre-login clean).
    if (url.includes('/tenant/me')) return jsonResponse({ defaultSttModel: null, features: {} });
    return jsonResponse({});
  };
}

describe('TASK-317 W1.2 — provider namespace wiring (AC-1/AC-4) re-keys managers to the authenticated ${tenantId}::${userId}', () => {
  it('AC-1: personalization IDB row is written under the authenticated namespace, never pre-login', async () => {
    handler = meHandler({ id: USER, tenantId: TENANT });

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const pm = store.getState().personalizationManager!;
    expect(pm).toBeTruthy();
    await pm.updatePreferences({ dnaStyleId: 'voice-profile-xyz' });

    expect(idbStore.get(`arcaai-personalization/${NS}`)).toMatchObject({ dnaStyleId: 'voice-profile-xyz' });
    expect(idbStore.has('arcaai-personalization/pre-login')).toBe(false);
  });

  it('AC-1: personalization hydrates the authenticated user row, not the pre-login bootstrap row', async () => {
    // The authenticated user already has a cached profile from a prior session.
    idbStore.set(`arcaai-personalization/${NS}`, { dnaStyleId: 'USER_77_PROFILE' });
    handler = meHandler({ id: USER, tenantId: TENANT });

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const pm = store.getState().personalizationManager!;
    // After /auth/me, the manager must re-key + re-hydrate from the user's row.
    await waitFor(() => expect(pm.getPreferences().dnaStyleId).toBe('USER_77_PROFILE'), { timeout: 2000 });
  });

  it('AC-4: selected-models localStorage key is the authenticated namespace, never pre-login', async () => {
    handler = meHandler({ id: USER, tenantId: TENANT });

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const mr = store.getState().modelRegistry!;
    expect(mr).toBeTruthy();
    mr.selectModel('stt', 'whisper-tiny');

    expect(localStorage.getItem(`arcaai-selected-models/${NS}`)).toContain('whisper-tiny');
    expect(localStorage.getItem('arcaai-selected-models/pre-login')).toBeNull();
  });

  it('AC-1/AC-4: switching tenant/user re-keys storage — reads the incoming row, writes the new namespace, leaves the outgoing row intact', async () => {
    handler = meHandler({ id: USER, tenantId: TENANT });

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const mr = store.getState().modelRegistry!;
    mr.selectModel('stt', 'whisper-tiny');
    expect(localStorage.getItem(`arcaai-selected-models/${NS}`)).toContain('whisper-tiny');

    // The incoming user has a different saved selection under their own namespace.
    const NS2 = 'tenant-2::user-99';
    localStorage.setItem(`arcaai-selected-models/${NS2}`, JSON.stringify({ stt: 'whisper-base' }));

    act(() => {
      store.getState().setImpersonatedUser({ id: 'user-99', tenantId: 'tenant-2' });
    });

    // Re-key reads the incoming user's row (whisper-base), NOT the outgoing user's whisper-tiny.
    await waitFor(() => expect(mr.getSelectedModelId('stt')).toBe('whisper-base'), { timeout: 2000 });

    // A new selection writes under the incoming namespace and does not touch the outgoing row.
    mr.selectModel('vad', 'silero-vad-v5');
    expect(localStorage.getItem(`arcaai-selected-models/${NS2}`)).toContain('silero-vad-v5');
    expect(localStorage.getItem(`arcaai-selected-models/${NS}`)).toContain('whisper-tiny');
  });
});
