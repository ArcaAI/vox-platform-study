/**
 * TASK-317 W2.1 (AC-7) — AgenticProvider tenant-switch session reset (audit C-5).
 *
 * Finding C-5: on a tenant switch / admin impersonation IN THE SAME TAB the
 * store keeps the previous tenant's session state — `consultation`,
 * `contextItems`, `transcriptSegments`, `summaries` (all PHI) plus the
 * tenant-scoped model config (`tenantConfig` + the `modelRegistry` selection
 * surfaced through `useArcaConfig`) — resident and visible until an explicit
 * close. There is therefore a window where tenant B is already active while
 * tenant A's PHI is still readable.
 *
 * AC-7: when `effectiveTenantId` changes, `AgenticProvider` must reset those
 * session slices BEFORE the new tenant config resolves, so the previous
 * tenant's PHI is never resident while the new tenant is active.
 *
 * These tests drive the REAL provider (mount -> /auth/me -> populate tenant-A
 * session state -> switch to tenant B) and assert the slices are cleared
 * SYNCHRONOUSLY on the switch — i.e. immediately after the state change that
 * triggers the re-hydrate effect, before its async tail (personalization
 * hydrate / config reload) has a chance to resolve. The harness mirrors
 * `AgenticProvider.namespacing.task317.test.ts` (W1).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { AgenticProvider } from '../AgenticProvider';
import { useAgenticStore } from '../../store/agenticStore';
import type { AgenticConfig, Consultation, ContextItem, SummaryResponse, TenantAudioConfig } from '../../types';
import type { TranscriptSegment } from '../../types/audio';

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

// In-memory IDB so the personalization re-hydrate has a backing store.
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

const TENANT_A = 'tenant-1';
const USER_A = 'user-77';
const TENANT_B = 'tenant-2';
const USER_B = 'user-99';

function renderProvider() {
  // Clean store snapshot. clearOnLogout takes the outgoing namespace (W1.4).
  useAgenticStore.getState().clearOnLogout('pre-login');

  const config: AgenticConfig = {
    api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: TENANT_A },
    personalization: { storage: 'local' },
  };
  const element = React.createElement(AgenticProvider, {
    config,
    children: React.createElement('div', null, 'child'),
  });
  render(element);
  return useAgenticStore;
}

function meHandler(me: { id?: string; tenantId?: string; departmentId?: string }): FetchHandler {
  return async (url) => {
    if (url.endsWith('/auth/me')) return jsonResponse(me);
    if (url.includes('/tenant/me')) return jsonResponse({ defaultSttModel: null, features: {} });
    return jsonResponse({});
  };
}

// Tenant-A session fixtures (stand-ins for PHI).
const consultationA = {
  id: 'consult-A',
  patientId: 'patient-A',
  doctorId: 'doctor-A',
  appointmentDate: '2026-05-30',
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
} as Consultation;

const contextItemsA = [
  {
    id: 'ctx-A',
    consultationId: 'consult-A',
    type: 'transcription',
    content: 'Tenant A chief complaint — PHI',
    source: 'human',
    isSummary: false,
    isTranscript: true,
    isAiGenerated: false,
    isCaseNote: false,
    isWorknote: false,
  },
] as unknown as ContextItem[];

const transcriptSegmentsA: TranscriptSegment[] = [{ text: 'Tenant A spoken PHI', startTime: 0, endTime: 1, isFinal: true }];

const summariesA = [
  {
    id: 'sum-A',
    contextItemId: 'ctx-A',
    content: 'Tenant A summary — PHI',
    type: 'summary',
    llmProvider: 'test',
    modelName: 'test-model',
    createdAt: '2026-05-30T00:00:00.000Z',
  },
] as SummaryResponse[];

const tenantConfigA = { defaultSttModel: 'whisper-tiny', features: {} } as TenantAudioConfig;

describe('TASK-317 W2.1 — tenant-switch session reset (C-5): same-tab tenant switch clears PHI + model/tenant config before the new tenant config resolves (AC-7)', () => {
  it('switch A->B resets consultation / contextItems / transcriptSegments / summaries / tenantConfig synchronously, before the async re-hydrate resolves', async () => {
    handler = meHandler({ id: USER_A, tenantId: TENANT_A });

    const store = renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    // ---- Populate tenant-A session state (PHI) + a tenant-A model selection.
    act(() => {
      store.getState().setConsultation(consultationA);
      store.getState().setContextItems(contextItemsA);
      store.getState().setTranscriptSegments(transcriptSegmentsA);
      store.getState().setSummaries(summariesA);
      store.getState().setTenantConfig(tenantConfigA);
    });

    const mr = store.getState().modelRegistry!;
    mr.selectModel('stt', 'whisper-tiny'); // persisted under tenant-A namespace
    expect(mr.getSelectedModelId('stt')).toBe('whisper-tiny');

    // Sanity: tenant-A session state is resident before the switch.
    expect(store.getState().consultation).not.toBeNull();
    expect(store.getState().contextItems).toHaveLength(1);
    expect(store.getState().transcriptSegments).toHaveLength(1);
    expect(store.getState().summaries).toHaveLength(1);
    expect(store.getState().tenantConfig).not.toBeNull();

    const versionBefore = store.getState().modelRegistryVersion;

    // ---- Switch tenant/user in the SAME tab. Tenant B has NO stored selection,
    // so a correct reset leaves the registry selection empty.
    act(() => {
      store.getState().setImpersonatedUser({ id: USER_B, tenantId: TENANT_B });
    });

    // ---- Assert SYNCHRONOUSLY (no await) — the re-hydrate effect's async tail
    // (hydrate / config reload) has NOT resolved yet, so this captures the
    // "new tenant active, previous tenant config not yet resolved" window.
    const after = store.getState();
    expect(after.consultation).toBeNull();
    expect(after.contextItems).toEqual([]);
    expect(after.transcriptSegments).toEqual([]);
    expect(after.summaries).toEqual([]);
    expect(after.tenantConfig).toBeNull();
    // modelRegistry: the outgoing tenant's selection is gone and the
    // useArcaConfig memo-bust signal has advanced.
    expect(after.modelRegistry!.getSelected()).toEqual({});
    expect(after.modelRegistryVersion).toBeGreaterThan(versionBefore);

    // Settle the async re-hydrate tail so its later store writes happen inside
    // act() (and confirm the reset is not undone once the new config resolves).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.getState().consultation).toBeNull();
    expect(store.getState().summaries).toEqual([]);
  });
});
