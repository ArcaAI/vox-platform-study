/**
 * @arcaai/vox - StreamingSessionManager
 *
 * Manages STT streaming session lifecycle:
 *   1. Create session (POST /audio/transcription-jobs/stream/session)
 *   2. Provide WebSocket URL for connection
 *   3. Close session and clean up
 *
 * @see SDK-206 Gap Analysis — ASR-R-02
 */

import type { AgenticClient } from './AgenticClient';
import { STT_ENDPOINTS } from './constants';
import type { ISDKLogger } from './logger';
import type { AsrSessionWarning } from '@arcaai/types';
import type { CreateStreamingSessionRequest, StreamingSessionResponse } from '../types/stt';

/** Direction of a live-session provider switch.*/
export type ProviderSwitchTarget = 'primary' | 'fallback';

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
  /**
   * The backend preseed echo (`voiceProfileSeeded`) from the
   * streaming-session response, so consumers can surface diarization-seeding
   * feedback without re-reading the raw response. `null` when no session exists
   * or the field was omitted by an older API revision.
   */
  voiceProfileSeeded: boolean | null;
  /** Non-fatal warnings from the session-creation response (TASK-1048); `[]` when none / no session. */
  warnings: AsrSessionWarning[];
}

/**
 * Manages the STT streaming session lifecycle.
 *
 * Usage:
 * ```typescript
 * const session = new StreamingSessionManager(apiClient, logger);
 *
 * // Step 1: Create session
 * const response = await session.createSession({
 *   agentSlug: 'clinic-asr',
 *   consultationId: 'consult-123',
 * });
 *
 * // Step 2: Get WebSocket URL
 * const wsUrl = session.getWebSocketUrl(jwtToken);
 * // → wss://api.example.com/ws/stt/stream?sessionId=X&token=JWT
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
   * Create a streaming session via the stt backend.
   * Stores the sessionId for subsequent WebSocket connection.
   */
  async createSession(request: CreateStreamingSessionRequest): Promise<StreamingSessionResponse> {
    if (this.sessionId) {
      const err = new Error(`Streaming session already exists (id: ${this.sessionId}). Call closeSession() first.`);
      this.errorListeners.forEach((cb) => cb(err));
      throw err;
    }

    this.status = 'creating';

    const body = this.normalizeSelection(request);

    this.logger?.debug('Creating streaming session', {
      operation: 'createSession',
      component: 'StreamingSessionManager',
      attributes: {
        agentSlug: body.agentSlug,
        consultationId: request.consultationId,
        sampleRate: request.sampleRate,
        language: request.language,
      },
    });

    try {
      const response = await this.apiClient.post<StreamingSessionResponse>(STT_ENDPOINTS.CREATE_SESSION, body);

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
   * Single chokepoint for WHAT the session asks to be transcribed by
   * (TASK-865, `pipelineId` removed TASK-1006). `agentSlug` names the
   * tenant's ASR Agent; when absent, nothing is sent and the gateway
   * resolves one itself — the request's `consultationId`'s governing
   * workflow first, when it names a speech-to-text agent, otherwise the
   * tenant admin's assignment (department, then tenant default).
   */
  private normalizeSelection(request: CreateStreamingSessionRequest): CreateStreamingSessionRequest {
    const { agentSlug, ...rest } = request;
    if (agentSlug) {
      return { ...rest, agentSlug };
    }
    return { ...rest };
  }

  /**
   * Build the full WebSocket URL for connecting to the stt stream.
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

    // `ApiConfig.wsUrl` (when set) wins over `baseUrl` for the WS
    // origin, so REST can ride a same-origin BFF proxy while the WebSocket
    // upgrade hits the gateway directly. `https/wss` → wss, `http/ws` → ws.
    const parsed = new URL(this.apiClient.getWsUrl() ?? this.apiClient.getBaseUrl());
    const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
    const wsOrigin = `${wsProtocol}//${parsed.host}`;

    const wsPath = this.sessionResponse.wsUrl || STT_ENDPOINTS.WS_STREAM;
    const params = new URLSearchParams({
      sessionId: this.sessionId,
    });
    // Append the one-shot stream ticket as a query param so
    // the gateway can authenticate the upgrade request without exposing the
    // JWT in URL logs.
    if (this.sessionResponse.ticket) {
      params.set('ticket', this.sessionResponse.ticket);
    }
    // Carry the active tenant id so the WS client's now-default-on
    // tenant-claim guard (`requireTenantClaim` defaults to true) can resolve a
    // claim from the URL. This is the single chokepoint for the SDK's own
    // streaming flow — `@arcaai/stt`'s StreamingBackendSTTProvider connects
    // with `connect(url)` (no options), so the claim MUST live in the URL.
    // When no tenant is set (e.g. an unscoped super-admin), nothing is appended
    // and the guard fails closed, which is the intended posture.
    const tenantId = this.apiClient.getTenantId();
    if (tenantId) {
      params.set('tenantId', tenantId);
    }

    return `${wsOrigin}${wsPath}?${params.toString()}`;
  }

  /**
   * Mint a fresh stream ticket for the current session.
   * Used by `SttWebSocketClient.attemptReconnect` to swap the consumed
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
    }>(STT_ENDPOINTS.REFRESH_TICKET(this.sessionId), {});

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
        await this.apiClient.delete(STT_ENDPOINTS.CLOSE_SESSION(closedId));
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

  /**
   * Switch the live streaming session's ASR engine.
   *   - `target: 'fallback'` — the tenant-admin default provider. Identical to
   *     {@link switchToFallback}.
   *   - `target: 'primary'` — switch BACK to the SDK-configured pipeline. POSTs
   *     the native `SWITCH_TO_PRIMARY` route, the primary-direction counterpart
   *     of the one-way fallback switch.
   *
   * The backend swaps the ASR engine while the WebSocket, Redis streams, and
   * session identity survive; the client is notified via the
   * `provider_switched` status frame. The HTTP error (404 unknown/cross-tenant
   * session, 409 no-fallback-configured) is preserved for the caller to
   * classify via `err.code`.
   *
   * @throws if no session exists, or with the classified backend error on failure.
   */
  async switchProvider(target: ProviderSwitchTarget): Promise<void> {
    if (target === 'primary') {
      return this.nativeSwitchToPrimary();
    }
    return this.nativeSwitchToFallback();
  }

  /**
   * Request an in-place switch of the live session to the tenant fallback
   * pipeline. Alias for `switchProvider('fallback')` — kept for
   * native callers (backward compatibility; zero behavior change).
   *
   * @throws if no session exists, or with the backend error on failure.
   */
  async switchToFallback(): Promise<void> {
    return this.switchProvider('fallback');
  }

  private async nativeSwitchToFallback(): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active streaming session — cannot switch to fallback.');
    }
    this.logger?.debug('Requesting streaming provider switch to fallback', {
      operation: 'switchToFallback',
      component: 'StreamingSessionManager',
      attributes: { sessionId: this.sessionId },
    });
    await this.apiClient.post(STT_ENDPOINTS.SWITCH_TO_FALLBACK(this.sessionId), {});
  }

  /**
   * Request an in-place switch of the live session BACK to its primary pipeline
   * The native primary-direction counterpart of
   * {@link nativeSwitchToFallback}. POSTs the `SWITCH_TO_PRIMARY` route; the
   * backend swaps the ASR engine while the WebSocket/session survive and the
   * client learns the new pipeline from the `provider_switched` status frame.
   *
   * @throws if no session exists, or with the backend error on failure.
   */
  private async nativeSwitchToPrimary(): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active streaming session — cannot switch to primary.');
    }
    this.logger?.debug('Requesting streaming provider switch to primary', {
      operation: 'switchToPrimary',
      component: 'StreamingSessionManager',
      attributes: { sessionId: this.sessionId },
    });
    await this.apiClient.post(STT_ENDPOINTS.SWITCH_TO_PRIMARY(this.sessionId), {});
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

  // ===========================================================================
  // Capture control (pause / resume on the live socket)
  // ===========================================================================

  /** The socket that carries the control frames; bound by whoever builds both. */
  private controlChannel: { pause(): void; resumeCapture(): void } | null = null;

  /** Bind the WebSocket client that `pauseCapture` / `resumeCapture` drive. */
  bindControlChannel(channel: { pause(): void; resumeCapture(): void } | null): void {
    this.controlChannel = channel;
  }

  /** Ask the server to pause capture on the live session. No-op when no socket is bound. */
  pauseCapture(): void {
    this.controlChannel?.pause();
  }

  /** Ask the server to resume a paused capture on the live session. No-op when no socket is bound. */
  resumeCapture(): void {
    this.controlChannel?.resumeCapture();
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
      voiceProfileSeeded: this.sessionResponse?.voiceProfileSeeded ?? null,
      warnings: this.sessionResponse?.warnings ?? [],
    };
  }
}
