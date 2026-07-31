import { CreateStreamingSessionRequest, StreamingSessionStatus, StreamingAvailability, SttLanguageModeCatalog } from './dto';

/**
 * Interface for the streaming session management service.
 *
 * This service communicates with the STT internal API to manage
 * streaming session lifecycle (create, status, finalize).
 */
export interface IStreamingSessionService {
  /**
   * Check if the STT streaming module is available and has capacity.
   */
  checkAvailability(): Promise<StreamingAvailability>;

  /**
   * Fetch the STT language-mode catalog + per-mode supported engines (TASK-587).
   * Backend-authoritative source of truth for the end-user language picker.
   */
  getLanguageModes(): Promise<SttLanguageModeCatalog>;

  /**
   * Create a new streaming session on STT.
   *
   * @param dto - Session creation parameters
   * @returns Session status or null if at capacity
   */
  createSession(dto: CreateStreamingSessionRequest): Promise<StreamingSessionStatus | null>;

  /**
   * Get the status of an existing streaming session.
   *
   * @param sessionId - The session identifier
   * @returns Session status or null if not found
   */
  getSessionStatus(sessionId: string): Promise<StreamingSessionStatus | null>;

  /**
   * Trigger a mid-session engine switch (TASK-567 R4, TASK-586).
   *
   * Bidirectional for user-initiated switches: `'fallback'` swaps to the
   * tenant's fallback pipeline, `'primary'` swaps back to the primary. POSTs
   * `{ target }` to the STT internal switch route.
   *
   * @param sessionId - The session identifier
   * @param target - The engine to switch to ('primary' | 'fallback')
   */
  switchProvider(sessionId: string, target: 'primary' | 'fallback'): Promise<void>;

  /**
   * Back-compat alias for `switchProvider(sessionId, 'fallback')` (TASK-567).
   *
   * @param sessionId - The session identifier
   */
  switchToFallback(sessionId: string): Promise<void>;

  /**
   * Finalize and remove a streaming session.
   *
   * @param sessionId - The session identifier
   */
  removeSession(sessionId: string): Promise<void>;
}
