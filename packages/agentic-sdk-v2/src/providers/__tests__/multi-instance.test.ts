/**
 * TASK-317 W4.4 (AC-13, audit C-1 + E-5) — concurrent multi-`AgenticProvider`
 * store isolation.
 *
 * Audit C-1: the Zustand store is a module-level singleton, so two
 * `AgenticProvider`s rendered in the same tree (multi-tenant operator console /
 * admin impersonation side-by-side) share ONE store and leak state across the
 * tenant boundary. E-5: there was no concurrent-provider test guarding this.
 *
 * The RED proof (against the module singleton) was committed earlier in W4: a
 * probe that captured each provider's store resolved BOTH providers to the SAME
 * object, so state written via tenant-A immediately appeared in tenant-B.
 *
 * GREEN (W4.2/W4.3): `AgenticProvider` now owns a per-instance store
 * (`createAgenticStore()` in a `useRef`, exposed via `AgenticStoreContext` /
 * `useStoreApi()`). Each probe captures an INDEPENDENT `StoreApi`, so the two
 * providers' state stays isolated.
 *
 * NOTE: this file is `.test.ts` (not `.tsx`) and builds its tree with
 * `React.createElement` — the canonical AgenticProvider integration-test
 * convention (see `AgenticProvider.namespacing.task317.test.ts`) so it is
 * matched by `vitest.config.ts` (`src/**\/*.test.ts`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { AgenticProvider } from '../AgenticProvider';
// Each provider exposes its own store instance through `useStoreApi()`.
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig, Consultation } from '../../types';

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

// In-memory IDB so each provider's personalization manager has a backing store.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  globalThis.fetch = vi.fn(async () => jsonResponse({ defaultSttModel: null, features: {} })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  idbStore.clear();
  localStorage.clear();
});

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

function makeConfig(tenantId: string): AgenticConfig {
  // No credentials → the provider skips /auth/me, keeping the test focused on
  // store identity/isolation rather than the auth bootstrap.
  return {
    api: { baseUrl: 'https://api.example.com', tenantId },
    personalization: { storage: 'local' },
  };
}

const consultationA = {
  id: 'consult-A',
  patientId: 'patient-A',
  doctorId: 'doctor-A',
  appointmentDate: '2026-05-30',
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
} as Consultation;

const consultationB = {
  id: 'consult-B',
  patientId: 'patient-B',
  doctorId: 'doctor-B',
  appointmentDate: '2026-05-30',
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
} as Consultation;

/**
 * Capture the per-provider `StoreApi` the surrounding `AgenticProvider` exposes
 * via `AgenticStoreContext`. Two providers → two independent stores.
 */
function makeStoreProbe(onStore: (store: AgenticStoreApi) => void): React.FC {
  return function StoreProbe() {
    onStore(useStoreApi());
    return null;
  };
}

/** Render tenant-A and tenant-B providers side by side; return their stores. */
async function renderTwoProviders(): Promise<{ a: AgenticStoreApi; b: AgenticStoreApi }> {
  const capturedA: { api: AgenticStoreApi | null } = { api: null };
  const capturedB: { api: AgenticStoreApi | null } = { api: null };

  const CaptureA = makeStoreProbe((s) => {
    capturedA.api = s;
  });
  const CaptureB = makeStoreProbe((s) => {
    capturedB.api = s;
  });

  render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(AgenticProvider, { config: makeConfig(TENANT_A), children: React.createElement(CaptureA) }),
      React.createElement(AgenticProvider, { config: makeConfig(TENANT_B), children: React.createElement(CaptureB) }),
    ),
  );

  await waitFor(() => {
    expect(capturedA.api).not.toBeNull();
    expect(capturedB.api).not.toBeNull();
  });

  if (!capturedA.api || !capturedB.api) throw new Error('AgenticProvider store API was not captured');
  return { a: capturedA.api, b: capturedB.api };
}

describe('TASK-317 W4 — multi-instance store isolation (C-1, E-5): two AgenticProviders in one tree must own independent stores', () => {
  it('two providers expose two DISTINCT store instances and do not share session state', async () => {
    const { a, b } = await renderTwoProviders();

    // (a) Each provider owns an independent store instance.
    expect(a).not.toBe(b);

    // (a cont.) State written through tenant-A must NOT appear in tenant-B.
    act(() => {
      a.getState().setConsultation(consultationA);
    });
    expect(a.getState().consultation).toMatchObject({ id: 'consult-A' });
    expect(b.getState().consultation).toBeNull();
  });

  it('(b) a mid-session tenant switch in one provider does not disturb the other', async () => {
    const { a, b } = await renderTwoProviders();

    // Both tenants have an active session (consultation PHI + raw transcript).
    act(() => {
      a.getState().setConsultation(consultationA);
      a.getState().setCurrentTranscript('tenant-A raw transcript — PHI');
      b.getState().setConsultation(consultationB);
      b.getState().setCurrentTranscript('tenant-B raw transcript — PHI');
    });

    // Tenant A switches tenant mid-session → its PHI/session slices reset
    // (`clearTenantSessionData()` is exactly what the provider runs on switch).
    act(() => {
      a.getState().clearTenantSessionData();
    });

    // A's session is gone; B's session is fully intact (no cross-tenant reset).
    expect(a.getState().consultation).toBeNull();
    expect(a.getState().currentTranscript).toBe('');
    expect(b.getState().consultation).toMatchObject({ id: 'consult-B' });
    expect(b.getState().currentTranscript).toBe('tenant-B raw transcript — PHI');
  });

  it('(c) impersonation start→stop in one provider keeps the other isolated', async () => {
    const { a, b } = await renderTwoProviders();

    // Tenant B has its own authenticated user + personalization.
    act(() => {
      b.getState().setAuthUser({ id: 'user-B', tenantId: TENANT_B });
      b.getState().setPreferences({ dnaStyleId: 'B-voice' });
    });

    // Tenant A's admin impersonates a different user and loads their profile.
    act(() => {
      a.getState().setAuthUser({ id: 'admin-A', tenantId: TENANT_A });
      a.getState().setOriginalUser(a.getState().authUser);
      a.getState().setImpersonatedUser({ id: 'patient-X', tenantId: TENANT_A });
      a.getState().setPreferences({ dnaStyleId: 'impersonated-voice' });
    });

    // A reflects impersonation; B is completely untouched.
    expect(a.getState().authImpersonatedUser).toMatchObject({ id: 'patient-X' });
    expect(a.getState().preferences).toMatchObject({ dnaStyleId: 'impersonated-voice' });
    expect(b.getState().authImpersonatedUser).toBeNull();
    expect(b.getState().authUser).toMatchObject({ id: 'user-B' });
    expect(b.getState().preferences).toMatchObject({ dnaStyleId: 'B-voice' });

    // A ends impersonation → reverts to the admin; B STILL isolated throughout.
    act(() => {
      a.getState().setImpersonatedUser(null);
      a.getState().setOriginalUser(null);
    });
    expect(a.getState().authImpersonatedUser).toBeNull();
    expect(a.getState().authUser).toMatchObject({ id: 'admin-A' });
    expect(b.getState().authUser).toMatchObject({ id: 'user-B' });
    expect(b.getState().preferences).toMatchObject({ dnaStyleId: 'B-voice' });
  });
});
