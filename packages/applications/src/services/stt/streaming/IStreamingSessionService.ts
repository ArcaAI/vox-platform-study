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
   * Fetch the STT language-mode catalog + per-mode supported engines.
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
   * @param tenantId - Owning tenant, threaded by callers that hold one so the
   * internal hop carries `X-Tenant-Id`. Omit ONLY on paths whose
   *   envelope genuinely has no tenant — those declare `tenantless:job-queue`.
   * @returns Session status or null if not found
   */
  getSessionStatus(sessionId: string, tenantId?: string | null): Promise<StreamingSessionStatus | null>;

  /**
   * Trigger a mid-session engine switch.
   *
   * Bidirectional for user-initiated switches: `'fallback'` swaps to the
   * tenant's fallback pipeline, `'primary'` swaps back to the primary. POSTs
   * `{ target }` to the STT internal switch route.
   *
   * @param sessionId - The session identifier
   * @param target - The engine to switch to ('primary' | 'fallback')
   * @param tenantId - Owning tenant for the internal hop's `X-Tenant-Id`.
   */
  switchProvider(sessionId: string, target: 'primary' | 'fallback', tenantId?: string | null): Promise<void>;

  /**
   * Back-compat alias for `switchProvider(sessionId, 'fallback')`.
   *
   * @param sessionId - The session identifier
   * @param tenantId - Owning tenant for the internal hop's `X-Tenant-Id`.
   */
  switchToFallback(sessionId: string, tenantId?: string | null): Promise<void>;

  /**
   * Finalize and remove a streaming session.
   *
   * on a real teardown, emits ONE `transcribe.stream` usage
   * row (SESSION_SECOND + AUDIO_SECOND). `interrupted` is a purely
   * gateway-side decision (STT has no concept of it) — pass `true` from an
   * abort path (resume-grace expiry, shutdown); leave the `false` default
   * for an explicit close. Both use the SAME idempotency key, so a
   * duplicate teardown call is a no-op at the ledger, never a double charge.
   *
   * @param sessionId - The session identifier
   * @param interrupted - Whether this teardown is an abort, not an explicit close (default false)
   * @param tenantId - Owning tenant for the internal hop's `X-Tenant-Id`. The
   *   background teardown paths (SIGTERM sweep, removal-retry drain) hold none
   *   and therefore declare `tenantless:job-queue` instead of omitting it.
   */
  removeSession(sessionId: string, interrupted?: boolean, tenantId?: string | null): Promise<void>;
}
