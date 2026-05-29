/**
 * TASK-317 W4.4 (AC-13, audit C-1 + E-5) — concurrent multi-`AgenticProvider`
 * store isolation.
 *
 * Audit C-1: the Zustand store is a module-level singleton, so two
 * `AgenticProvider`s rendered in the same tree (multi-tenant operator console /
 * admin impersonation side-by-side) share ONE store and leak state across the
 * tenant boundary. E-5: there was no concurrent-provider test guarding this.
 *
 * RED (this commit): the probe captures the store each provider exposes. Against
 * the current module singleton BOTH providers resolve to the SAME store object,
 * so (a) the two captured stores are identical and (b) state written through
 * tenant-A's store is immediately visible through tenant-B's store. The
 * isolation assertions below therefore FAIL — proving C-1.
 *
 * GREEN (W4.4): once `AgenticProvider` owns a per-instance store
 * (`createAgenticStore()` in a `useRef`, exposed via `AgenticStoreContext` /
 * `useStoreApi()`), the probe captures two independent stores and isolation
 * holds.
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
// RED: the only store available pre-fix is the module-level singleton. The
// GREEN rewrite (W4.4) swaps this for the per-provider `useStoreApi()` handle.
import { useAgenticStore } from '../../store/agenticStore';
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

/**
 * Capture the store object the surrounding provider exposes. In the current
 * (pre-fix) code the only store is the module singleton, so every capture
 * resolves to the same object — which is exactly what makes the isolation
 * assertions RED.
 */
function makeCaptureStore(onStore: (store: typeof useAgenticStore) => void): React.FC {
  return function CaptureStore() {
    onStore(useAgenticStore);
    return null;
  };
}

describe('TASK-317 W4 — multi-instance store isolation (C-1, E-5): two AgenticProviders in one tree must own independent stores', () => {
  it('two providers expose two DISTINCT store instances and do not share session state', async () => {
    let storeA: typeof useAgenticStore | null = null;
    let storeB: typeof useAgenticStore | null = null;

    const CaptureA = makeCaptureStore((s) => {
      storeA = s;
    });
    const CaptureB = makeCaptureStore((s) => {
      storeB = s;
    });

    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(AgenticProvider, { config: makeConfig(TENANT_A) }, React.createElement(CaptureA), React.createElement('div', null, 'tenant-A')),
        React.createElement(AgenticProvider, { config: makeConfig(TENANT_B) }, React.createElement(CaptureB), React.createElement('div', null, 'tenant-B')),
      ),
    );

    await waitFor(() => {
      expect(storeA).not.toBeNull();
      expect(storeB).not.toBeNull();
    });

    const a = storeA!;
    const b = storeB!;

    // (a) Independent instances — RED today (both are the module singleton).
    expect(a).not.toBe(b);

    // (a cont.) State written through tenant-A must NOT appear in tenant-B.
    act(() => {
      a.getState().setConsultation(consultationA);
    });
    expect(a.getState().consultation).toMatchObject({ id: 'consult-A' });
    expect(b.getState().consultation).toBeNull();
  });
});
