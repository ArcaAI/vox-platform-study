/**
 * Effective transcription-mode population.
 *
 * The effective transcription mode is resolved per-user SERVER-SIDE in
 * UserPreferencesService (locked ⇒ tenant default; unlocked ⇒ workflowMode) and
 * returned on `GET /user/me/preferences` as `transcriptionMode`. The provider
 * must surface it into `resolvedConfig.stt.transcriptionMode` via the admin/
 * tenant tier so the clinical workspace branches LOCAL vs BACKEND, and so a user
 * preference cannot override it (the field is `permission: 'admin'`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, waitFor } from '@testing-library/react';
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

  const element = React.createElement(
    AgenticProvider,
    {
      config: {
        api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: 'tenant-1' },
        audio: undefined,
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

function handlerWithMode(transcriptionMode?: 'LOCAL' | 'BACKEND'): FetchHandler {
  return (url: string) => {
    if (url.endsWith('/auth/me')) {
      return Promise.resolve(jsonResponse({ id: 'user-1', tenantId: 'tenant-1' }));
    }
    if (url.includes('/tenant/me')) {
      return Promise.resolve(jsonResponse({ defaultSttModel: 'whisper-base', features: {} }));
    }
    if (url.includes('/user/me/preferences')) {
      return Promise.resolve(
        jsonResponse(transcriptionMode ? { transcriptionMode, transcriptionModeLocked: true } : {}),
      );
    }
    return Promise.resolve(jsonResponse({}));
  };
}

describe('TASK-356 SDK-T2 — effective transcription-mode population', () => {
  it('injects the server-resolved transcriptionMode into resolvedConfig.stt.transcriptionMode (LOCAL)', async () => {
    handler = handlerWithMode('LOCAL');

    const store = await renderProvider();

    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().resolvedConfig?.stt?.transcriptionMode).toBe('LOCAL');
  });

  it('keeps the resolved mode authoritative — a user preference cannot override it', async () => {
    handler = handlerWithMode('LOCAL');

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    const configManager = store.getState().configManager;
    expect(configManager).toBeTruthy();

    // stt.transcriptionMode is permission: 'admin' -> setUserValue must reject.
    const accepted = configManager!.setUserValue('stt.transcriptionMode', 'BACKEND');
    expect(accepted).toBe(false);
    expect(store.getState().resolvedConfig?.stt?.transcriptionMode).toBe('LOCAL');
  });

  it('leaves transcriptionMode undefined when the server resolves none (back-compat)', async () => {
    handler = handlerWithMode(undefined);

    const store = await renderProvider();
    await waitFor(() => expect(store.getState().configReady).toBe(true), { timeout: 2000 });

    expect(store.getState().resolvedConfig?.stt?.transcriptionMode).toBeUndefined();
  });
});
