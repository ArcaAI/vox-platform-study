/**
 * User preferences sync to the server.
 *
 * Before this fix the production `AgenticProvider` wired ONLY local-storage
 * persistence (`makePersistUserPreferencesToStorage`) — a user's SDK prefs
 * never reached `PATCH /users/me/settings`, so they never synced to the
 * doctor's real/server profile or other devices.
 *
 * Fix: an ADDITIVE, debounced server sync. When NOT impersonating
 * (`ConfigManager.readOnly === false`), each changed user-pref LEAF is
 * flattened to a dot-path and PATCHed to
 * `/users/me/settings/arcaai-sdk/{dotPath}` with the stringified value and the
 * correct `dataType`. Local-storage persistence is untouched (server sync is
 * additive) and a failed PATCH never breaks it.
 *
 * The read-only short-circuit is REUSED: while impersonating the
 * playground flips `ConfigManager.setReadOnly(true)`, so the server sync is
 * gated off and an admin's impersonated edits never reach the doctor's server
 * profile.
 *
 * These tests drive the REAL provider and the REAL ConfigManager it owns,
 * asserting the network behaviour through a fetch spy.
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
type PatchCall = { url: string; body: Record<string, unknown> | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;
let handler: FetchHandler;
let patchCalls: PatchCall[];

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  patchCalls = [];
  fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PATCH') {
      let body: Record<string, unknown> | undefined;
      try {
        body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      patchCalls.push({ url: u, body });
      return jsonResponse({ id: 'setting-1', namespace: 'arcaai-sdk', key: u.split('/').pop(), value: '' });
    }
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
const DOCTOR = 'doctor-99';

const SDK_NS = '/users/me/settings/arcaai-sdk/';

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

function sdkPatches(): PatchCall[] {
  return patchCalls.filter((c) => c.url.includes(SDK_NS));
}

function findPatch(dotPath: string): PatchCall | undefined {
  return patchCalls.find((c) => c.url.includes(`${SDK_NS}${dotPath}`));
}

describe('doc-07 F5a — AgenticProvider server preference sync', () => {
  it('PATCHes each user-pref leaf to /users/me/settings/arcaai-sdk/{dotPath} with value + dataType when NOT impersonating', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const cm = store.getState().configManager!;
    expect(cm.isReadOnly()).toBe(false);

    act(() => {
      cm.setUserValue('stt.language', 'fr'); // string  -> String
      cm.setUserValue('audio.noiseSuppression', false); // boolean -> Boolean
    });

    // The sync is debounced; poll until the PATCHes land.
    await waitFor(() => expect(sdkPatches().length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    const langPatch = findPatch('stt.language');
    expect(langPatch).toBeDefined();
    expect(langPatch!.body).toEqual({ value: 'fr', dataType: 'String' });

    const nsPatch = findPatch('audio.noiseSuppression');
    expect(nsPatch).toBeDefined();
    expect(nsPatch!.body).toEqual({ value: 'false', dataType: 'Boolean' });
  });

  it('debounces rapid edits to the same leaf into a single PATCH carrying the latest value', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    const cm = store.getState().configManager!;

    act(() => {
      cm.setUserValue('stt.language', 'a');
      cm.setUserValue('stt.language', 'b');
      cm.setUserValue('stt.language', 'c');
    });

    await waitFor(() => expect(findPatch('stt.language')).toBeDefined(), { timeout: 3000 });
    // Give any stragglers a beat, then assert the debounce coalesced to ONE call.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    const langPatches = patchCalls.filter((c) => c.url.includes(`${SDK_NS}stt.language`));
    expect(langPatches).toHaveLength(1);
    expect(langPatches[0].body).toEqual({ value: 'c', dataType: 'String' });
  });

  it('maps numeric leaves to Float/Integer dataType (restore path, not impersonating)', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    const cm = store.getState().configManager!;

    // restoreUserPreferences() is the END-of-impersonation persist trigger
    // (readOnly already false); it replaces the whole tier and persists.
    act(() => {
      cm.restoreUserPreferences({
        stt: { language: 'de' },
        audio: { vadThreshold: 0.25, sampleRate: 16000 },
      });
    });

    await waitFor(() => expect(sdkPatches().length).toBeGreaterThanOrEqual(3), { timeout: 3000 });

    expect(findPatch('stt.language')!.body).toEqual({ value: 'de', dataType: 'String' });
    expect(findPatch('audio.vadThreshold')!.body).toEqual({ value: '0.25', dataType: 'Float' });
    expect(findPatch('audio.sampleRate')!.body).toEqual({ value: '16000', dataType: 'Integer' });
  });

  it('does NOT PATCH while impersonating (readOnly=true)', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const cm = store.getState().configManager!;

    // Mirror the playground's impersonation start: flip read-only, load the
    // impersonated doctor's prefs, then the admin edits them.
    act(() => {
      cm.setReadOnly(true);
      cm.loadExternalPreferences({ stt: { language: 'hi' } });
      cm.setUserValue('stt.language', 'fr');
      cm.setUserValue('audio.noiseSuppression', false);
    });

    // Wait well past the debounce window — nothing should reach the server.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });

    expect(sdkPatches()).toHaveLength(0);
    expect(cm.isReadOnly()).toBe(true);
  });

  it('drops an already-scheduled sync if impersonation starts before the debounce fires', async () => {
    handler = meHandler({ id: ADMIN, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    const cm = store.getState().configManager!;

    act(() => {
      // Admin edits a pref (schedules a debounced flush — not impersonating yet)...
      cm.setUserValue('stt.language', 'fr');
      // ...then impersonation starts BEFORE the debounce window elapses. The
      // pending PATCH must NOT land on the impersonated doctor's profile.
      cm.setReadOnly(true);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });

    expect(sdkPatches()).toHaveLength(0);
  });

  it('keeps local-storage persistence working (additive) when NOT impersonating', async () => {
    handler = meHandler({ id: DOCTOR, tenantId: TENANT_A });
    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    const cm = store.getState().configManager!;

    act(() => {
      cm.setUserValue('stt.language', 'es');
    });

    await waitFor(() => expect(findPatch('stt.language')).toBeDefined(), { timeout: 3000 });

    // Local IDB namespace still carries the pref (server sync is additive).
    const stored = idbStore.get(`user-preferences/${TENANT_A}::${DOCTOR}`) as { stt?: { language?: string } } | undefined;
    expect(stored?.stt?.language).toBe('es');
  });
});
