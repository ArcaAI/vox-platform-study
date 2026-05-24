/**
 * @arcaai/vox - StreamingSessionManager
 *
 * Manages STT-V2 streaming session lifecycle:
 *   1. Create session (POST /audio/transcription-jobs/stream/session)
 *   2. Provide WebSocket URL for connection
 *   3. Close session and clean up
 *
 * @see SDK-206 Gap Analysis — ASR-R-02
 */

import type { AgenticClient } from './AgenticClient';
import { STT_V2_ENDPOINTS } from './constants';
import type { ISDKLogger } from './logger';
import type { CreateStreamingSessionRequest, StreamingSessionResponse } from '../types/stt-v2';

/**
 * Session manager status values
 */
export type SessionManagerStatus = 'idle' | 'creating' | 'session_created' | 'closed' | 'error';

/**
 * Session state snapshot
 */
export interface SessionManagerState {
  sessionId: string | null;
  status: SessionManagerStatus;
  maxConcurrent: number | null;
  currentActive: number | null;
}

/**
 * Manages the STT-V2 streaming session lifecycle.
 *
 * Usage:
 * ```typescript
 * const session = new StreamingSessionManager(apiClient, logger);
 *
 * // Step 1: Create session
 * const response = await session.createSession({
 *   pipelineId: 'default-pipeline',
 *   consultationId: 'consult-123',
 * });
 *
 * // Step 2: Get WebSocket URL
 * const wsUrl = session.getWebSocketUrl(jwtToken);
 * // → wss://api.example.com/ws/stt-v2/stream?sessionId=X&token=JWT
 *
 * // Step 3: Close when done
 * session.closeSession();
 * ```
 */
export class StreamingSessionManager {
  private apiClient: AgenticClient;
  private logger?: ISDKLogger;

  private sessionId: string | null = null;
  private sessionResponse: StreamingSessionResponse | null = null;
  private status: SessionManagerStatus = 'idle';

  private sessionCreatedListeners = new Set<(response: StreamingSessionResponse) => void>();
  private sessionClosedListeners = new Set<(sessionId: string) => void>();
  private errorListeners = new Set<(error: Error) => void>();

  constructor(apiClient: AgenticClient, logger?: ISDKLogger) {
    this.apiClient = apiClient;
    this.logger = logger;
  }

  /**
   * Create a streaming session via the stt-v2 backend.
   * Stores the sessionId for subsequent WebSocket connection.
   */
  async createSession(request: CreateStreamingSessionRequest): Promise<StreamingSessionResponse> {
    if (this.sessionId) {
      const err = new Error(`Streaming session already exists (id: ${this.sessionId}). Call closeSession() first.`);
      this.errorListeners.forEach((cb) => cb(err));
      throw err;
    }

    this.status = 'creating';

    this.logger?.debug('Creating streaming session', {
      operation: 'createSession',
      component: 'StreamingSessionManager',
      attributes: {
        pipelineId: request.pipelineId,
        consultationId: request.consultationId,
        sampleRate: request.sampleRate,
        language: request.language,
      },
    });

    try {
      const response = await this.apiClient.post<StreamingSessionResponse>(STT_V2_ENDPOINTS.CREATE_SESSION, request);

      this.sessionId = response.sessionId;
      this.sessionResponse = response;
      this.status = 'session_created';

      this.logger?.info('Streaming session created', {
        operation: 'createSession',
        component: 'StreamingSessionManager',
        success: true,
        attributes: {
          sessionId: response.sessionId,
          maxConcurrent: response.maxConcurrent,
          currentActive: response.currentActive,
          wsUrl: response.wsUrl,
        },
      });

      this.sessionCreatedListeners.forEach((cb) => cb(response));

      return response;
    } catch (error) {
      this.status = 'error';

      this.logger?.error('Failed to create streaming session', {
        operation: 'createSession',
        component: 'StreamingSessionManager',
        error: error as Error,
      });

      this.errorListeners.forEach((cb) => cb(error as Error));
      throw error;
    }
  }

  /**
   * Build the full WebSocket URL for connecting to the stt-v2 stream.
   * Returns null if no session has been created.
   *
   * SECURITY: The JWT token is NOT included in the URL to prevent exposure
   * in server logs, proxy logs, browser history, and CDN caches.
   * The token parameter is accepted for API compatibility but ignored in the URL.
   * Callers should send the token as the first WebSocket message after connecting:
   *   ws.send(JSON.stringify({ type: 'auth', token }));
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Kept for API compatibility; token sent via first WS message.
  getWebSocketUrl(_token?: string): string | null {
    if (!this.sessionId || !this.sessionResponse) {
      return null;
    }

    const baseUrl = this.apiClient.getBaseUrl();
    const parsed = new URL(baseUrl);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsOrigin = `${wsProtocol}//${parsed.host}`;

    const wsPath = this.sessionResponse.wsUrl || STT_V2_ENDPOINTS.WS_STREAM;
    const params = new URLSearchParams({
      sessionId: this.sessionId,
    });
    // TASK-298 D-1: append the one-shot stream ticket as a query param so
    // the gateway can authenticate the upgrade request without exposing the
    // JWT in URL logs.
    if (this.sessionResponse.ticket) {
      params.set('ticket', this.sessionResponse.ticket);
    }

    return `${wsOrigin}${wsPath}?${params.toString()}`;
  }

  /**
   * TASK-298 D-18: Mint a fresh stream ticket for the current session.
   * Used by `SttV2WebSocketClient.attemptReconnect` to swap the consumed
   * ticket with a new one before reopening the WebSocket.
   *
   * @throws if no session exists or the backend returns an error.
   */
  async refreshTicket(): Promise<string> {
    if (!this.sessionId || !this.sessionResponse) {
      throw new Error('No active streaming session — cannot refresh ticket.');
    }

    this.logger?.debug('Refreshing stream ticket for reconnect', {
      operation: 'refreshTicket',
      component: 'StreamingSessionManager',
      attributes: { sessionId: this.sessionId },
    });

    const response = await this.apiClient.post<{
      ticket: string;
      ticketExpiresAt: number;
    }>(STT_V2_ENDPOINTS.REFRESH_TICKET(this.sessionId), {});

    this.sessionResponse = {
      ...this.sessionResponse,
      ticket: response.ticket,
      ticketExpiresAt: response.ticketExpiresAt,
    };
    return response.ticket;
  }

  /**
   * Close the current session, notify the backend, and reset local state.
   * Safe to call even when no session exists.
   * Backend errors are logged but do not prevent local cleanup.
   */
  async closeSession(): Promise<void> {
    const closedId = this.sessionId;

    this.logger?.debug('Closing streaming session', {
      operation: 'closeSession',
      component: 'StreamingSessionManager',
      attributes: { sessionId: closedId },
    });

    if (closedId) {
      try {
        await this.apiClient.delete(STT_V2_ENDPOINTS.CLOSE_SESSION(closedId));
      } catch (err) {
        this.logger?.warn('Failed to close session on server — local state still cleaned up', {
          operation: 'closeSession',
          component: 'StreamingSessionManager',
          error: err as Error,
          attributes: { sessionId: closedId },
        });
      }
    }

    this.sessionId = null;
    this.sessionResponse = null;
    this.status = 'closed';

    if (closedId) {
      this.sessionClosedListeners.forEach((cb) => cb(closedId));
    }
  }

  // ===========================================================================
  // Event registration
  // ===========================================================================

  onSessionCreated(cb: (response: StreamingSessionResponse) => void): () => void {
    this.sessionCreatedListeners.add(cb);
    return () => {
      this.sessionCreatedListeners.delete(cb);
    };
  }

  onSessionClosed(cb: (sessionId: string) => void): () => void {
    this.sessionClosedListeners.add(cb);
    return () => {
      this.sessionClosedListeners.delete(cb);
    };
  }

  onError(cb: (error: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  // ===========================================================================
  // State accessors
  // ===========================================================================

  getSessionId(): string | null {
    return this.sessionId;
  }

  getStatus(): SessionManagerStatus {
    return this.status;
  }

  getState(): SessionManagerState {
    return {
      sessionId: this.sessionId,
      status: this.status,
      maxConcurrent: this.sessionResponse?.maxConcurrent ?? null,
      currentActive: this.sessionResponse?.currentActive ?? null,
    };
  }
}
