/**
 * @vitest-environment jsdom
 *
 * TASK-586 Lane D — `StreamingSessionManager` compat provider-switch routing.
 *
 * Lives under `compat/__tests__/` (Lane D's file-ownership boundary) even
 * though it exercises a core class, because `StreamingSessionManager.ts` is
 * one of the two core files Lane D owns exclusively. Verifies the hard
 * requirement of contract C3: with compat mode enabled, `switchProvider(...)`
 * POSTs the LITERAL `/api/stt/switch` shim (mirroring how `useSMR` derives its
 * shim origin) with `target: 'pipeline' | 'default'`; with compat mode OFF
 * (the default — every native SDK consumer), each direction hits its native
 * route via `apiClient` — `SWITCH_TO_FALLBACK` for `'fallback'` and, since
 * TASK-586 Lane H, `SWITCH_TO_PRIMARY` for `'primary'` (native 2-way switch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamingSessionManager } from '../../core/StreamingSessionManager';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';
import { AgenticClient } from '../../core/AgenticClient';
import { STT_ENDPOINTS } from '../../core/constants';
import type { StreamingSessionResponse } from '../../types/stt';

describe('StreamingSessionManager — compat provider switch (TASK-586 Lane D)', () => {
  let manager: StreamingSessionManager;
  let apiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  const sessionResponse: StreamingSessionResponse = {
    sessionId: 'sess-compat-1',
    status: 'active',
    maxConcurrent: 5,
    currentActive: 1,
    wsUrl: '/ws/stt/stream',
  };

  beforeEach(async () => {
    mockLogger = createMockLogger();
    apiClient = new AgenticClient(
      {
        baseUrl: 'https://api.example.com/api/v1',
        apiKey: 'tenant-key-123',
        wsUrl: 'wss://api.example.com',
      },
      mockLogger,
    );
    manager = new StreamingSessionManager(apiClient, mockLogger);

    mockFetch.mockResolvedValueOnce(createMockResponse(sessionResponse));
    await manager.createSession({ pipelineId: 'primary-pipeline' });
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('native mode (default — every pre-586 / non-compat caller)', () => {
    it('switchProvider("fallback") is byte-identical to switchToFallback(): native SWITCH_TO_FALLBACK route via apiClient', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true }));

      await manager.switchProvider('fallback');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(STT_ENDPOINTS.SWITCH_TO_FALLBACK('sess-compat-1'));
      expect(url).not.toContain('/api/stt/switch');
    });

    it('switchToFallback() keeps hitting the native route (backward compat)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true }));

      await manager.switchToFallback();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(STT_ENDPOINTS.SWITCH_TO_FALLBACK('sess-compat-1'));
    });

    it('switchProvider("primary") now POSTs the native SWITCH_TO_PRIMARY route (TASK-586 Lane H — native 2-way switch)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true }));

      await manager.switchProvider('primary');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(STT_ENDPOINTS.SWITCH_TO_PRIMARY('sess-compat-1'));
      expect(url).not.toContain('/api/stt/switch');
    });
  });

  describe('compat mode (setCompatSwitchEnabled(true) — Lane D bidirectional toggle)', () => {
    beforeEach(() => {
      manager.setCompatSwitchEnabled(true);
    });

    it('switchProvider("primary") POSTs the literal /api/stt/switch shim with target "pipeline"', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true, active: 'pipeline' }));

      await manager.switchProvider('primary');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/stt/switch');
      expect(url).not.toContain('/api/v1');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ session_id: 'sess-compat-1', target: 'pipeline' });
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('tenant-key-123');
    });

    it('switchProvider("fallback") ALSO routes through /api/stt/switch with target "default" once compat mode is on', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true, active: 'default' }));

      await manager.switchProvider('fallback');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/stt/switch');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ session_id: 'sess-compat-1', target: 'default' });
    });

    it('switchToFallback() also routes through the compat shim once enabled (alias honors compat mode)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true }));

      await manager.switchToFallback();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.example.com/api/stt/switch');
    });

    it('propagates a classified 404 (unknown/cross-tenant session) so the caller can branch on err.code', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Not Found'));

      await expect(manager.switchProvider('primary')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('propagates a 409 (no tenant fallback configured) as a distinct classified error', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(409, 'Conflict'));

      await expect(manager.switchProvider('fallback')).rejects.toMatchObject({ status: 409 });
    });

    it('throws when there is no active session', async () => {
      const freshManager = new StreamingSessionManager(apiClient, mockLogger);
      freshManager.setCompatSwitchEnabled(true);

      await expect(freshManager.switchProvider('primary')).rejects.toThrow(/no active streaming session/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
