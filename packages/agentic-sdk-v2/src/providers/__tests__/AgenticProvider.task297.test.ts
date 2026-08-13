/**
 * AgenticProvider integration coverage.
 *
 * - DEF-C6: /auth/me is awaited before `configReady` flips.
 * - DEF-H5: tenant-config fetch happens once per mount.
 * - DEF-C6 failure path: /auth/me 401 keeps configReady false.
 * - DEF-C6 no-credentials path: /auth/me is not called pre-login.
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

  // The provider owns a per-instance store (fresh
  // `createAgenticStore()` at the initial state), so no pre-render reset is
  // needed. Capture this provider's StoreApi via `useStoreApi()` and return it;
  // the test body's `useAgenticStore.getState()` then observes the provider's store.
  const captured: { api: AgenticStoreApi | null } = { api: null };
  const Capture: React.FC = () => {
    captured.api = useStoreApi();
    return null;
  };

  const element = React.createElement(AgenticProvider, {
    config: {
      api: { baseUrl: 'https://api.example.com', apiKey: 'k', accessToken: 'access', tenantId: 'tenant-1' },
      audio: undefined,
      personalization: { storage: 'local' },
      ...configOverride,
    },
    children: React.createElement(Capture),
  } as never) as React.ReactElement;
  render(element);
  if (!captured.api) throw new Error('AgenticProvider store API was not captured');
  return captured.api;
}

describe('AgenticProvider', () => {
  it('DEF-C6: configReady stays false until /auth/me resolves; tenant config fetched once (DEF-H5)', async () => {
    const meCalls: number[] = [];
    let resolveMe!: (v: { id: string }) => void;
    const mePromise = new Promise<{ id: string }>((res) => {
      resolveMe = res;
    });

    let tenantCfgCalls = 0;
    handler = async (url) => {
      if (url.endsWith('/auth/me')) {
        meCalls.push(Date.now());
        const me = await mePromise;
        return jsonResponse(me);
      }
      // `/tenant/me/config` specifically — added a SIBLING endpoint
      // `/tenant/me/context-schema`, which also matches a loose
      // `includes('/tenant/me')` check and would otherwise double-count here.
      if (url.includes('/tenant/me/config')) {
        tenantCfgCalls += 1;
        return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      }
      if (url.includes('/tenant/me/context-schema')) {
        return jsonResponse({ etag: 'none' });
      }
      return jsonResponse({});
    };

    const useAgenticStore = await renderProvider();

    await new Promise((r) => setTimeout(r, 40));
    expect(useAgenticStore.getState().configReady).toBe(false);

    resolveMe({ id: 'user-77' });

    await waitFor(
      () => {
        expect(useAgenticStore.getState().configReady).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(useAgenticStore.getState().profileReady).toBe(true);
    expect(useAgenticStore.getState().authUser).toMatchObject({ id: 'user-77' });
    expect(meCalls).toHaveLength(1);
    expect(tenantCfgCalls).toBe(1);
  });

  it('DEF-C6: /auth/me 401 leaves configReady false', async () => {
    handler = async (url) => {
      if (url.endsWith('/auth/me')) {
        return jsonResponse({ message: 'unauthorized' }, 401);
      }
      if (url.includes('/tenant/me')) {
        return jsonResponse({ defaultSttModel: 'whisper-base', features: {} });
      }
      return jsonResponse({});
    };

    const useAgenticStore = await renderProvider();

    await new Promise((r) => setTimeout(r, 120));
    expect(useAgenticStore.getState().configReady).toBe(false);
    expect(useAgenticStore.getState().profileReady).toBe(false);
  });

  it('DEF-C6: without credentials at mount, /auth/me is not called and configReady stays false', async () => {
    let calledMe = false;
    handler = async (url) => {
      if (url.endsWith('/auth/me')) {
        calledMe = true;
        return jsonResponse({});
      }
      if (url.includes('/tenant/me')) {
        return jsonResponse({ defaultSttModel: null, features: {} });
      }
      return jsonResponse({});
    };

    const useAgenticStore = await renderProvider({
      api: { baseUrl: 'https://api.example.com' },
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(calledMe).toBe(false);
    expect(useAgenticStore.getState().configReady).toBe(false);
    expect(useAgenticStore.getState().profileReady).toBe(false);
  });
});
