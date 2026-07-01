/**
 * @arcaai/vox - Monitoring Types (TASK-032 WS-A)
 *
 * Types for service monitoring and health tracking.
 * Matches MonitoringController responses.
 */

export interface ServiceUptime {
  service: string;
  status: string;
  uptimeSeconds: number;
  [key: string]: unknown;
}

/** Per-service active-session count (matches `SessionsResponse.services.*`). */
export interface ServiceSessionCount {
  active: number;
}

/**
 * Session counts, realigned to the backend `SessionsResponse` (TASK-386 /
 * `MonitoringController.getSessions`):
 *
 *   { services: { smr|stt|nlp|guardrail|harness: { active } }, totalUsers, refreshedAt }
 *
 * The `services` map + `totalUsers` are the AUTHORITATIVE backend shape. The
 * `activeSessions` / `processingJobs` / `active` / `total` fields are kept as
 * DERIVED convenience values for the platform dashboard tiles (see
 * `normalizeSessionCounts`), so existing consumers don't break.
 */
export interface SessionCounts {
  /** Per-service active sessions (authoritative backend shape). */
  services: {
    smr: ServiceSessionCount;
    stt: ServiceSessionCount;
    nlp: ServiceSessionCount;
    guardrail: ServiceSessionCount;
    harness: ServiceSessionCount;
  };
  /** Total unique users with sessions (authoritative backend field). */
  totalUsers: number;
  /** When the backend computed the payload (ISO-8601). */
  refreshedAt?: string;

  // ── Derived convenience fields (back-compat with pre-TASK-386 consumers) ──
  /** Live consultation sessions ≈ STT streams (`services.stt.active`). */
  activeSessions: number;
  /** Background inference jobs ≈ SMR + NLP + guardrail + harness active. */
  processingJobs: number;
  /** Alias of `activeSessions` (legacy). */
  active: number;
  /** Total active sessions across all services (legacy). */
  total: number;
}

export interface HeartbeatRecord {
  timestamp: string;
  status: string;
  latencyMs?: number;
  [key: string]: unknown;
}
