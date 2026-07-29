/**
 * StreamingSessionManager Unit Tests — ASR-R-02
 *
 * TDD tests for the STT streaming session lifecycle manager.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamingSessionManager } from '../StreamingSessionManager';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';
import { AgenticClient } from '../AgenticClient';
import { STT_ENDPOINTS } from '../constants';
import type { CreateStreamingSessionRequest, StreamingSessionResponse } from '../../types/stt';

describe('StreamingSessionManager', () => {
  let manager: StreamingSessionManager;
  let apiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    apiClient = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        wsUrl: 'wss://api.example.com',
      },
      mockLogger,
    );
    manager = new StreamingSessionManager(apiClient, mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create an instance with apiClient and logger', () => {
      expect(manager).toBeDefined();
      expect(manager.getSessionId()).toBeNull();
      expect(manager.getStatus()).toBe('idle');
    });

    it('should create an instance without logger', () => {
      const mgr = new StreamingSessionManager(apiClient);
      expect(mgr).toBeDefined();
      expect(mgr.getStatus()).toBe('idle');
    });
  });

  // ===========================================================================
  // createSession
  // ===========================================================================

  describe('createSession', () => {
    const mockSessionResponse: StreamingSessionResponse = {
      sessionId: 'session-abc-123',
      status: 'active',
      maxConcurrent: 5,
      currentActive: 1,
      wsUrl: '/ws/stt/stream',
    };

    it('should create a streaming session and return the response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      const request: CreateStreamingSessionRequest = {
        pipelineId: 'default-pipeline',
        consultationId: 'consultation-123',
        sampleRate: 16000,
        language: 'en',
      };

      const result = await manager.createSession(request);

      expect(result).toEqual(mockSessionResponse);
      expect(result.sessionId).toBe('session-abc-123');
      expect(result.wsUrl).toBe('/ws/stt/stream');
    });

    it('should store the sessionId after creation', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      await manager.createSession({ pipelineId: 'default' });

      expect(manager.getSessionId()).toBe('session-abc-123');
    });

    it('should update status to session_created after creation', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      await manager.createSession({ pipelineId: 'default' });

      expect(manager.getStatus()).toBe('session_created');
    });

    it('should call the correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      await manager.createSession({ pipelineId: 'default' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.CREATE_SESSION);
    });

    it('should send the full request body', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      const request: CreateStreamingSessionRequest = {
        pipelineId: 'whisper-pipeline',
        consultationId: 'consult-456',
        sampleRate: 44100,
        language: 'th',
        microphoneId: 'mic-1',
      };

      await manager.createSession(request);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(callBody.pipelineId).toBe('whisper-pipeline');
      expect(callBody.consultationId).toBe('consult-456');
      expect(callBody.sampleRate).toBe(44100);
      expect(callBody.language).toBe('th');
      expect(callBody.microphoneId).toBe('mic-1');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

      await expect(manager.createSession({ pipelineId: 'default' })).rejects.toThrow();
    });

    it('should set status to error on failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

      try {
        await manager.createSession({ pipelineId: 'default' });
      } catch {
        // expected
      }

      expect(manager.getStatus()).toBe('error');
    });

    it('should handle network errors (fetch rejection)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(manager.createSession({ pipelineId: 'default' })).rejects.toThrow();
      expect(manager.getStatus()).toBe('error');
    });

    it('should not allow creating a session when one already exists', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      await expect(manager.createSession({ pipelineId: 'other' })).rejects.toThrow(/session already exists/i);
    });

    it('should fire onError callback on duplicate session attempt', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      const onError = vi.fn();
      manager.onError(onError);

      try {
        await manager.createSession({ pipelineId: 'other' });
      } catch {
        // expected
      }

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/session already exists/i),
        }),
      );
    });

    it('should have status creating during the async API call', async () => {
      let statusDuringCall: string | undefined;
      mockFetch.mockImplementationOnce(async () => {
        statusDuringCall = manager.getStatus();
        return createMockResponse(mockSessionResponse);
      });

      await manager.createSession({ pipelineId: 'default' });

      expect(statusDuringCall).toBe('creating');
      expect(manager.getStatus()).toBe('session_created');
    });
  });

  // ===========================================================================
  // getWebSocketUrl
  // ===========================================================================

  describe('getWebSocketUrl', () => {
    const mockSessionResponse: StreamingSessionResponse = {
      sessionId: 'session-ws-test',
      status: 'active',
      maxConcurrent: 5,
      currentActive: 1,
      wsUrl: '/ws/stt/stream',
    };

    it('should build the full WebSocket URL with sessionId (no token in URL)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      const wsUrl = manager.getWebSocketUrl('my-jwt-token');

      expect(wsUrl).toContain('/ws/stt/stream');
      expect(wsUrl).toContain('sessionId=session-ws-test');
      expect(wsUrl).not.toContain('token=');
    });

    it('should return null when no session exists', () => {
      const wsUrl = manager.getWebSocketUrl('token');
      expect(wsUrl).toBeNull();
    });

    it('should use the wsUrl from ApiConfig as the base', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      const wsUrl = manager.getWebSocketUrl('token');

      expect(wsUrl).toMatch(/^wss:\/\/api\.example\.com\/ws\/stt\/stream/);
    });

    it('should convert http:// base to ws:// in WebSocket URL', async () => {
      const httpClient = new AgenticClient({ baseUrl: 'http://localhost:8868/api/v1', apiKey: 'key' }, mockLogger);
      const httpManager = new StreamingSessionManager(httpClient, mockLogger);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await httpManager.createSession({ pipelineId: 'default' });

      const wsUrl = httpManager.getWebSocketUrl('tok');

      expect(wsUrl).toMatch(/^ws:\/\/localhost:8868\/ws\/stt\/stream/);
      expect(wsUrl).not.toContain('/api/v1');
      expect(wsUrl).not.toContain('wss:');
    });

    // -------------------------------------------------------------------
    // BFF split: REST rides a same-origin proxy (baseUrl) while
    // the WebSocket must hit the gateway directly. When ApiConfig.wsUrl is
    // set, its ORIGIN wins over baseUrl for the WS URL.
    // -------------------------------------------------------------------

    it('uses the ApiConfig.wsUrl origin when it differs from baseUrl (BFF REST + direct gateway WS)', async () => {
      const bffClient = new AgenticClient({ baseUrl: 'http://localhost:5176/api/hope', wsUrl: 'http://localhost:8868' }, mockLogger);
      const bffManager = new StreamingSessionManager(bffClient, mockLogger);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await bffManager.createSession({ pipelineId: 'default' });

      const wsUrl = bffManager.getWebSocketUrl();

      expect(wsUrl).toMatch(/^ws:\/\/localhost:8868\/ws\/stt\/stream/);
      expect(wsUrl).toContain('sessionId=session-ws-test');
      expect(wsUrl).not.toContain('5176');
    });

    it('normalizes an https wsUrl to wss and keeps an explicit wss wsUrl as-is', async () => {
      const httpsClient = new AgenticClient({ baseUrl: 'http://localhost:5176/api/hope', wsUrl: 'https://gateway.example.com' }, mockLogger);
      const httpsManager = new StreamingSessionManager(httpsClient, mockLogger);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await httpsManager.createSession({ pipelineId: 'default' });
      expect(httpsManager.getWebSocketUrl()).toMatch(/^wss:\/\/gateway\.example\.com\/ws\/stt\/stream/);

      const wssClient = new AgenticClient({ baseUrl: 'http://localhost:5176/api/hope', wsUrl: 'wss://gateway.example.com' }, mockLogger);
      const wssManager = new StreamingSessionManager(wssClient, mockLogger);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await wssManager.createSession({ pipelineId: 'default' });
      expect(wssManager.getWebSocketUrl()).toMatch(/^wss:\/\/gateway\.example\.com\/ws\/stt\/stream/);
    });

    it('should fall back to STT_ENDPOINTS.WS_STREAM when server returns empty wsUrl', async () => {
      const emptyWsUrlResponse: StreamingSessionResponse = {
        ...mockSessionResponse,
        wsUrl: '',
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(emptyWsUrlResponse));
      await manager.createSession({ pipelineId: 'default' });

      const wsUrl = manager.getWebSocketUrl('token');

      expect(wsUrl).toContain(STT_ENDPOINTS.WS_STREAM);
    });

    it('should not include token in URL even with special characters', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      const wsUrl = manager.getWebSocketUrl('token=with&special chars');

      expect(wsUrl).not.toContain('token=');
      expect(wsUrl).toContain('sessionId=session-ws-test');
    });

    it('SEC-01: should NOT include JWT token in the WebSocket URL query string', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });

      const wsUrl = manager.getWebSocketUrl('secret-jwt-token');

      expect(wsUrl).not.toBeNull();
      expect(wsUrl).toContain('sessionId=session-ws-test');
      expect(wsUrl).not.toContain('secret-jwt-token');
      expect(wsUrl).not.toContain('token=');
    });

    // -------------------------------------------------------------------
    // The WS client's tenant-claim guard is now ON BY DEFAULT
    // (`requireTenantClaim` defaults to true). `getWebSocketUrl` is the single
    // chokepoint for the SDK's own streaming flow (the STT provider connects
    // with `connect(url)` and no options), so the active tenant id MUST ride
    // in the URL for that flow to keep working.
    // -------------------------------------------------------------------
    describe('tenant claim in the URL', () => {
      it('appends the active tenantId so the default-on WS guard can resolve a claim', async () => {
        apiClient.updateTenantId('tenant-xyz');
        mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
        await manager.createSession({ pipelineId: 'default' });

        const wsUrl = manager.getWebSocketUrl('token');

        expect(wsUrl).toContain('tenantId=tenant-xyz');
        expect(wsUrl).toContain('sessionId=session-ws-test');
      });

      it('URL-encodes a tenantId that contains special characters', async () => {
        apiClient.updateTenantId('tenant/with space');
        mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
        await manager.createSession({ pipelineId: 'default' });

        const wsUrl = manager.getWebSocketUrl('token');

        // URLSearchParams encodes '/' and ' ' — the raw form must not leak.
        expect(wsUrl).toContain('tenantId=tenant%2Fwith+space');
        expect(wsUrl).not.toContain('tenant/with space');
      });

      it('omits tenantId when no tenant is set (guard then fails closed, per AC-10)', async () => {
        // apiClient has no tenantId (constructor config omits it).
        mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
        await manager.createSession({ pipelineId: 'default' });

        const wsUrl = manager.getWebSocketUrl('token');

        expect(wsUrl).not.toContain('tenantId=');
      });
    });
  });

  // ===========================================================================
  // closeSession
  // ===========================================================================

  describe('closeSession', () => {
    const mockSessionResponse: StreamingSessionResponse = {
      sessionId: 'session-close-test',
      status: 'active',
      maxConcurrent: 5,
      currentActive: 1,
      wsUrl: '/ws/stt/stream',
    };

    it('should reset sessionId and status after closing', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });
      expect(manager.getSessionId()).toBe('session-close-test');

      mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));
      await manager.closeSession();

      expect(manager.getSessionId()).toBeNull();
      expect(manager.getStatus()).toBe('closed');
    });

    it('should be safe to call when no session exists', async () => {
      await expect(manager.closeSession()).resolves.not.toThrow();
      expect(manager.getStatus()).toBe('closed');
    });

    it('should NOT fire onSessionClosed when no session existed', async () => {
      const onClosed = vi.fn();
      manager.onSessionClosed(onClosed);

      await manager.closeSession();

      expect(onClosed).not.toHaveBeenCalled();
    });

    it('should allow creating a new session after closing', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));
      await manager.createSession({ pipelineId: 'default' });
      mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));
      await manager.closeSession();

      const newResponse: StreamingSessionResponse = {
        ...mockSessionResponse,
        sessionId: 'session-new-123',
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(newResponse));

      const result = await manager.createSession({ pipelineId: 'other' });
      expect(result.sessionId).toBe('session-new-123');
      expect(manager.getSessionId()).toBe('session-new-123');
    });
  });

  // ===========================================================================
  // Event callbacks
  // ===========================================================================

  describe('event callbacks', () => {
    it('should register and call onSessionCreated callback', async () => {
      const mockSessionResponse: StreamingSessionResponse = {
        sessionId: 'session-event-test',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
        wsUrl: '/ws/stt/stream',
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      const onCreated = vi.fn();
      manager.onSessionCreated(onCreated);

      await manager.createSession({ pipelineId: 'default' });

      expect(onCreated).toHaveBeenCalledWith(mockSessionResponse);
    });

    it('should register and call onSessionClosed callback', async () => {
      const mockSessionResponse: StreamingSessionResponse = {
        sessionId: 'session-close-event',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
        wsUrl: '/ws/stt/stream',
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      const onClosed = vi.fn();
      manager.onSessionClosed(onClosed);

      await manager.createSession({ pipelineId: 'default' });
      mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));
      await manager.closeSession();

      expect(onClosed).toHaveBeenCalledWith('session-close-event');
    });

    it('should register and call onError callback', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

      const onError = vi.fn();
      manager.onError(onError);

      try {
        await manager.createSession({ pipelineId: 'default' });
      } catch {
        // expected
      }

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  // ===========================================================================
  // State inspection
  // ===========================================================================

  describe('state inspection', () => {
    it('should expose session metadata', async () => {
      const mockSessionResponse: StreamingSessionResponse = {
        sessionId: 'session-meta',
        status: 'active',
        maxConcurrent: 10,
        currentActive: 3,
        wsUrl: '/ws/stt/stream',
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      await manager.createSession({
        pipelineId: 'default',
        consultationId: 'consult-789',
      });

      const state = manager.getState();
      expect(state.sessionId).toBe('session-meta');
      expect(state.status).toBe('session_created');
      expect(state.maxConcurrent).toBe(10);
      expect(state.currentActive).toBe(3);
    });

    it('should return idle state when no session exists', () => {
      const state = manager.getState();
      expect(state.sessionId).toBeNull();
      expect(state.status).toBe('idle');
      expect(state.maxConcurrent).toBeNull();
      expect(state.currentActive).toBeNull();
      expect(state.voiceProfileSeeded).toBeNull();
    });

    // Surface the backend preseed echo on the state
    // snapshot so consumers can show diarization-seeding feedback.
    it('should expose voiceProfileSeeded from the session response', async () => {
      const mockSessionResponse: StreamingSessionResponse = {
        sessionId: 'session-seeded',
        status: 'active',
        maxConcurrent: 10,
        currentActive: 1,
        wsUrl: '/ws/stt/stream',
        voiceProfileSeeded: true,
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockSessionResponse));

      await manager.createSession({ pipelineId: 'default' });

      expect(manager.getState().voiceProfileSeeded).toBe(true);
    });
  });

  // =========================================================================
  // Server-side session cleanup
  // =========================================================================

  describe('closeSession should notify the backend', () => {
    it('should DELETE the session on the server when closing an active session', async () => {
      const sessionResponse: StreamingSessionResponse = {
        sessionId: 'session-cleanup',
        status: 'active',
        wsUrl: '/ws/stt/stream',
        maxConcurrent: 5,
        currentActive: 1,
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(sessionResponse));

      await manager.createSession({
        pipelineId: 'default',
        consultationId: 'consult-cleanup',
      });

      // Reset mock to track the close call
      mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

      await manager.closeSession();

      // Verify DELETE was called with the session ID
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toContain('session-cleanup');
      expect(lastCall[1]?.method).toBe('DELETE');
      expect(manager.getStatus()).toBe('closed');
    });

    it('should still reset local state even if server DELETE fails', async () => {
      const sessionResponse: StreamingSessionResponse = {
        sessionId: 'session-fail',
        status: 'active',
        wsUrl: '/ws/stt/stream',
        maxConcurrent: 5,
        currentActive: 1,
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(sessionResponse));

      await manager.createSession({
        pipelineId: 'default',
        consultationId: 'consult-fail',
      });

      // Server returns error on close
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await manager.closeSession();

      expect(manager.getSessionId()).toBeNull();
      expect(manager.getStatus()).toBe('closed');
    });
  });

  // =========================================================================
  // REFACTOR-05: on* methods should support multiple listeners
  // =========================================================================

  describe('REFACTOR-05: multi-listener event pattern', () => {
    it('onSessionCreated should support multiple listeners', async () => {
      const manager = new StreamingSessionManager(apiClient, mockLogger);

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onSessionCreated(listener1);
      manager.onSessionCreated(listener2);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          sessionId: 'sess-multi',
          wsUrl: 'wss://api.example.com/ws/stream?sessionId=sess-multi',
        }),
      );

      await manager.createSession({
        pipelineId: 'default',
        consultationId: 'consult-multi',
      });

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('on* should return an unsubscribe function', async () => {
      const manager = new StreamingSessionManager(apiClient, mockLogger);

      const listener = vi.fn();
      const unsub = manager.onSessionCreated(listener);

      expect(typeof unsub).toBe('function');

      unsub();

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          sessionId: 'sess-unsub',
          wsUrl: 'wss://api.example.com/ws/stream?sessionId=sess-unsub',
        }),
      );

      await manager.createSession({
        pipelineId: 'default',
        consultationId: 'consult-unsub',
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // switchToFallback (TASK-567 R4)
  // ===========================================================================

  describe('switchToFallback', () => {
    async function createSession(): Promise<void> {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ sessionId: 'sess-switch', wsUrl: '/ws/stt/stream', status: 'active', maxConcurrent: 5, currentActive: 1 }),
      );
      await manager.createSession({ pipelineId: 'primary' });
    }

    it('POSTs the switch-to-fallback endpoint for the live session', async () => {
      await createSession();
      mockFetch.mockClear();
      mockFetch.mockResolvedValueOnce(createMockResponse({ switched: true }));

      await manager.switchToFallback();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(STT_ENDPOINTS.SWITCH_TO_FALLBACK('sess-switch'));
    });

    it('throws when there is no active session', async () => {
      await expect(manager.switchToFallback()).rejects.toThrow(/no active streaming session/i);
    });

    it('propagates a 404 so the caller can classify it (degraded path)', async () => {
      await createSession();
      mockFetch.mockClear();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Not Found'));

      await expect(manager.switchToFallback()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
