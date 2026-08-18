/**
 * Preference isolation: ONE writer owns
 * `ConfigManager.userPreferences` during impersonation.
 *
 * Two systems used to mutate the user-preferences tier on impersonate/end:
 *   (A) the playground (`user-list.tsx`) loads the impersonated user's REAL
 *       backend prefs read-only via `loadExternalPreferences`, and
 *   (B) this provider's identity-change rehydrate calls
 *       `clearUserPreferences()` + `loadUserPreferences()` — but
 *       `loadUserPreferences()` is LOCAL-IDB-ONLY (`onLoadUserPreferences`
 *       reads IndexedDB/localStorage, never the backend), and the impersonated
 *       user has NO local namespace on the admin's machine. So (B) wipes the
 *       prefs (A) just loaded; whichever async path resolves last wins → the
 *       playground may show DEFAULTS instead of the impersonated user's prefs.
 *
 * Fix: the rehydrate SKIPS the user-pref clear/load while `authImpersonatedUser`
 * is set (the playground is the single writer), and re-runs it on END
 * impersonation (identity reverts to the admin → reload the admin's own
 * namespace). The tenant-session reset, model-registry reload, tenant config
 * and DEPARTMENT tier (F-9) still run during impersonation.
 *
 * These tests drive the REAL provider and spy on the REAL ConfigManager it
 * owns, asserting the decision branch behaviourally.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { AgenticProvider } from '../AgenticProvider';
import { ConfigManager } from '../../core/ConfigManager';
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig } from '../../types';
import type { AppConfig, DeepPartial } from '../../core/ConfigSchema';

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

// In-memory IDB so the user-preferences load/persist has a backing store.
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

type FetchHandler = (url: string) => Promise<Response>;

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

const TENANT_A = 'tenant-1';
const ADMIN = 'admin-77';
const TENANT_B = 'tenant-2';
const DOCTOR = 'doctor-99';
const DOCTOR_DEPT = 'dept-99';

function meHandler(me: { id?: string; tenantId?: string; departmentId?: string }): FetchHandler {
  return async (url) => {
    if (url.endsWith('/auth/me')) return jsonResponse(me);
    if (url.includes('/tenants/me')) return jsonResponse({ defaultSttModel: null, features: {} });
    return jsonResponse({});
  };
}

function renderProvider(): AgenticStoreApi {
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

// The impersonated user's REAL backend prefs (fetched by the playground via
// the doctor JWT) — a distinctive non-default that defaults would never show.
const doctorPrefs = { transcription: { language: 'fr' } } as DeepPartial<AppConfig>;

describe('doc-05 F-2 — AgenticProvider preference isolation under impersonation', () => {
  it('does NOT clear/reload (wipe) the playground-loaded impersonation prefs while impersonating', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const cm = store.getState().configManager!;
    const clearSpy = vi.spyOn(cm, 'clearUserPreferences');
    const loadSpy = vi.spyOn(cm, 'loadUserPreferences');

    // (1) Enter impersonation — provider rehydrate fires for the doctor namespace.
    act(() => {
      store.getState().setImpersonatedUser({ id: DOCTOR, tenantId: TENANT_B, departmentId: DOCTOR_DEPT });
    });
    // (2) Playground loads the impersonated user's REAL backend prefs read-only.
    act(() => {
      cm.setReadOnly(true);
      cm.loadExternalPreferences(doctorPrefs);
    });
    // Settle the provider's async re-hydrate tail. WITHOUT the fix this is where
    // clearUserPreferences()+loadUserPreferences() (doctor's local namespace is
    // EMPTY on the admin's machine) wipe the prefs just loaded.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // The single-writer invariant: the provider must NOT touch the user-pref tier
    // during impersonation, so the impersonated user's prefs win (not defaults).
    expect(clearSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(cm.getUserPreferences()).toEqual(doctorPrefs);
    expect(cm.isReadOnly()).toBe(true);
  });

  it('re-runs the user-pref rehydrate when impersonation ENDS (identity reverts to the admin)', async () => {
    // Seed the admin's own stored prefs so the end-of-impersonation reload has
    // something to restore from the admin's IndexedDB namespace.
    const adminPrefs = { transcription: { language: 'en' } } as DeepPartial<AppConfig>;
    idbStore.set(`user-preferences/${TENANT_A}::${ADMIN}`, adminPrefs);

    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const cm = store.getState().configManager!;

    // Enter impersonation + load the doctor's prefs (single writer = playground).
    act(() => {
      store.getState().setImpersonatedUser({ id: DOCTOR, tenantId: TENANT_B, departmentId: DOCTOR_DEPT });
    });
    act(() => {
      cm.setReadOnly(true);
      cm.loadExternalPreferences(doctorPrefs);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cm.getUserPreferences()).toEqual(doctorPrefs);

    // END impersonation — spy AFTER the start settled so we measure only the
    // revert transition. The provider must re-run the rehydrate for the admin
    // namespace (it is no longer skipped once impersonation is over).
    const clearSpy = vi.spyOn(cm, 'clearUserPreferences');
    const loadSpy = vi.spyOn(cm, 'loadUserPreferences');
    act(() => {
      cm.setReadOnly(false);
      store.getState().setImpersonatedUser(null);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(cm.isReadOnly()).toBe(false);
    // The doctor's prefs are no longer the resolved user tier — the admin's
    // namespace was reloaded.
    expect(cm.getUserPreferences()).not.toEqual(doctorPrefs);
  });
});
