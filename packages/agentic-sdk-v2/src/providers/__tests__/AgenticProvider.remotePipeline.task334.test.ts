/**
 * Remote pipeline-id population.
 *
 * The assigned remote ASR pipeline is resolved per-user server-side
 * (admin override -> tenant default -> global) and returned on
 * `GET /user/me/preferences` as `remoteConfig.pipelineId`. The provider must
 * surface it into `resolvedConfig.stt.transcriptionPipelineId` via the
 * admin/tenant tier so the consultation panel runs the correct pipeline
 * instead of falling back to the hardcoded default, and so a user preference
 * cannot override it (the field is `permission: 'admin'`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import type { AgenticStoreApi } from '../../store/agenticStore';

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
  fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return handler(u, init);
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderProvider(configOverride: Record<string, unknown> = {}) {
  const { AgenticProvider } = await import('../AgenticProvider.js');
  const { useStoreApi } = await import('../../store/agenticStore.js');

  const captured: { api: AgenticStoreApi | null } = { api: null };
  const Capture: React.FC = () => {
    captured.api = useStoreApi();
    return null;
  };

  const element = React.createElement(
    AgenticProvider,
    {
      config: {
        api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: 'tenant-1' },
        audio: undefined,
        // 'backend' so loadFromBackend() fires (skipped under 'local') and the
        // load path never touches IndexedDB (saveLocal only runs for 'hybrid').
        personalization: { storage: 'backend' },
        ...configOverride,
      },
      children: React.createElement(Capture),
    } as never,
  ) as React.ReactElement;
  render(element);
  if (!captured.api) throw new Error('AgenticProvider store API was not captured');
  return captured.api;
}

const REMOTE_PIPELINE_ID = 'pipe-remote-1';

function defaultHandler(url: string): Promise<Response> {
  if (url.endsWith('/auth/me')) {
    return Promise.resolve(jsonResponse({ id: 'user-1', tenantId: 'tenant-1' }));
  }
  if (url.includes('/tenant/me')) {
    return Promise.resolve(jsonResponse({ defaultSttModel: 'whisper-base', features: {} }));
  }
  if (url.includes('/user/me/preferences')) {
    return Promise.resolve(
      jsonResponse({ remoteConfig: { pipelineId: REMOTE_PIPELINE_ID, assignedBy: 'admin' } }),
    );
  }
  return Promise.resolve(jsonResponse({}));
}

describe('remote pipeline-id population', () => {
  it('injects remoteConfig.pipelineId into resolvedConfig.stt.transcriptionPipelineId', async () => {
    handler = defaultHandler;

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBe(REMOTE_PIPELINE_ID);
  });

  it('keeps the assigned pipeline id authoritative — a user preference cannot override it', async () => {
    handler = defaultHandler;

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const configManager = store.getState().configManager;
    expect(configManager).toBeTruthy();

    // stt.transcriptionPipelineId is permission: 'admin' -> setUserValue must
    // reject and the resolved value must remain the server-assigned pipeline.
    const accepted = configManager!.setUserValue('stt.transcriptionPipelineId', 'pipe-hacked');
    expect(accepted).toBe(false);
    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBe(REMOTE_PIPELINE_ID);
  });

  it('omits the override when no remote pipeline is assigned (field stays undefined)', async () => {
    handler = async (url) => {
      if (url.includes('/user/me/preferences')) {
        return jsonResponse({});
      }
      return defaultHandler(url);
    };

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBeUndefined();
  });

  // ===========================================================================
  // Impersonation parity — a same-tab user switch must re-resolve the pipeline.
  //
  // mount-time init() (deps []) is the ONLY place that injected
  // remoteConfig.pipelineId into the cascade tenant tier, and it runs ONCE with
  // the MOUNTING identity (the admin). On impersonation `effectiveUserId`
  // changes and the *second* effect re-hydrates the namespace — but it used to
  // only refresh `store.tenantConfig` (display) and never re-applied the cascade
  // tenant tier, so `resolvedConfig.stt.transcriptionPipelineId` kept the
  // admin's (empty) value and the panel fell back to the hardcoded SYSTEM
  // DEFAULT pipeline → cross-tenant 404. The switch must re-fetch the incoming
  // user's resolved pipeline and re-apply it.
  // ===========================================================================
  it('re-applies the impersonated user resolved pipeline to the cascade on a same-tab user switch', async () => {
    // Mount as an ADMIN with NO assigned pipeline (remoteConfig empty).
    handler = async (url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ id: 'admin-1', tenantId: 'tenant-1' });
      if (url.includes('/tenant/me')) return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      if (url.includes('/user/me/preferences')) return jsonResponse({});
      return jsonResponse({});
    };

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });
    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBeUndefined();

    // Impersonate a doctor whose server-resolved pipeline is tenant-owned.
    const DOCTOR_PIPELINE = 'pipe-doctor-streamable';
    handler = async (url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ id: 'doctor-2', tenantId: 'tenant-1' });
      if (url.includes('/tenant/me')) return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      if (url.includes('/user/me/preferences')) {
        return jsonResponse({ remoteConfig: { pipelineId: DOCTOR_PIPELINE, assignedBy: 'admin' } });
      }
      return jsonResponse({});
    };

    act(() => {
      (store.getState() as unknown as { setImpersonatedUser: (u: unknown) => void }).setImpersonatedUser({
        id: 'doctor-2',
        tenantId: 'tenant-1',
      });
    });

    await waitFor(
      () => expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBe(DOCTOR_PIPELINE),
      { timeout: 2000 },
    );
  });
});
