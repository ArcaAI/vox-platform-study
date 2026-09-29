/**
 * Remote pipeline-id population — REMOVED (TASK-1012).
 *
 * The provider used to read `remoteConfig.pipelineId` off `GET /users/me/preferences` and
 * inject it into `resolvedConfig.stt.transcriptionPipelineId`. The gateway has not sent
 * `remoteConfig` since TASK-1006 (`AsrPipeline` is gone; ASR is selected by the gateway from
 * the tenant's agent assignment), so that injection was dead. These tests pin its ABSENCE:
 * even a (stale) `remoteConfig.pipelineId` never reaches the cascade, on mount or on a
 * same-tab user switch. `stt.transcriptionPipelineId` stays admin-owned (a user preference
 * still cannot set it) and is `@deprecated`, removed in 5.0.0.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import type { AgenticStoreApi } from '../../store/agenticStore';

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
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
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

  const element = React.createElement(AgenticProvider, {
    config: {
      api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: 'tenant-1' },
      audio: undefined,
      // 'backend' so loadFromBackend() fires (skipped under 'local') and the
      // load path never touches IndexedDB (saveLocal only runs for 'hybrid').
      personalization: { storage: 'backend' },
      ...configOverride,
    },
    children: React.createElement(Capture),
  } as never) as React.ReactElement;
  render(element);
  if (!captured.api) throw new Error('AgenticProvider store API was not captured');
  return captured.api;
}

const REMOTE_PIPELINE_ID = 'pipe-remote-1';

function defaultHandler(url: string): Promise<Response> {
  if (url.endsWith('/auth/me')) {
    return Promise.resolve(jsonResponse({ id: 'user-1', tenantId: 'tenant-1' }));
  }
  if (url.includes('/tenants/me')) {
    return Promise.resolve(jsonResponse({ defaultSttModel: 'whisper-base', features: {} }));
  }
  if (url.includes('/users/me/preferences')) {
    return Promise.resolve(jsonResponse({ remoteConfig: { pipelineId: REMOTE_PIPELINE_ID, assignedBy: 'admin' } }));
  }
  return Promise.resolve(jsonResponse({}));
}

describe('remote pipeline-id population is gone (TASK-1012)', () => {
  it('never injects remoteConfig.pipelineId into resolvedConfig.stt.transcriptionPipelineId', async () => {
    handler = defaultHandler;

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBeUndefined();
  });

  it('keeps stt.transcriptionPipelineId admin-owned — a user preference cannot set it', async () => {
    handler = defaultHandler;

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const configManager = store.getState().configManager;
    expect(configManager).toBeTruthy();

    const accepted = configManager!.setUserValue('stt.transcriptionPipelineId', 'pipe-hacked');
    expect(accepted).toBe(false);
    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBeUndefined();
  });

  it('does not inject a pipeline on a same-tab user switch either, while still re-applying the transcription mode', async () => {
    handler = async (url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ id: 'admin-1', tenantId: 'tenant-1' });
      if (url.includes('/tenants/me')) return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      if (url.includes('/users/me/preferences')) return jsonResponse({});
      return jsonResponse({});
    };

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    handler = async (url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ id: 'doctor-2', tenantId: 'tenant-1' });
      if (url.includes('/tenants/me')) return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      if (url.includes('/users/me/preferences')) {
        return jsonResponse({ remoteConfig: { pipelineId: 'pipe-doctor-streamable', assignedBy: 'admin' }, transcriptionMode: 'LOCAL' });
      }
      return jsonResponse({});
    };

    act(() => {
      (store.getState() as unknown as { setImpersonatedUser: (u: unknown) => void }).setImpersonatedUser({
        id: 'doctor-2',
        tenantId: 'tenant-1',
      });
    });

    await waitFor(() => expect(store.getState().resolvedConfig?.stt?.transcriptionMode).toBe('LOCAL'), { timeout: 2000 });
    expect(store.getState().resolvedConfig?.stt?.transcriptionPipelineId).toBeUndefined();
  });
});
