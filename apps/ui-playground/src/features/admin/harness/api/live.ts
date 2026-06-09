import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient, type RequestOptions } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — TASK-341 (Admin Harness Live console). Mirror the backend DTOs in
// `@arcaai/applications` (`live-doc-admin.dto.ts`):
//   - GET   /admin/harness/live/sessions      → LiveDocSessionsListResponse
//   - GET   /admin/harness/live/sessions/:id  → LiveDocSessionStatsResponse
//   - GET   /admin/harness/live/config        → LiveDocEngineConfigResponse
//   - PATCH /admin/harness/live/config        → LiveDocEngineConfigResponse
//
// Re-declared locally because `@arcaai/applications` is a server-only NestJS
// package this Vite app cannot depend on. Keep in lock-step with the backend.
// ---------------------------------------------------------------------------

/** PHI-safe per-session live-documentation stats (sizes / latencies / counts only). */
export interface LiveDocSessionStats {
  consultationId: string;
  tenantId: string;
  sessionId?: string;
  startedAt: string;
  lastUpdatedAt: string;
  flushCount: number;
  generation: number;
  smrLatencyMs: number;
  nlpLatencyMs: number;
  smrFailed: boolean;
  nlpFailed: boolean;
  staleDropCount: number;
  entityCount: number;
  sectionCount: number;
  summaryChars: number;
}

/** A tenant's active live-documentation sessions. */
export interface LiveDocSessionsList {
  items: LiveDocSessionStats[];
  total: number;
}

/** Where the effective live-engine enabled flag was resolved from. */
export type LiveDocEngineConfigSource = 'env-default' | 'redis-override';

/** The effective live-documentation engine config / kill-switch. */
export interface LiveDocEngineConfig {
  enabled: boolean;
  envDefault: boolean;
  source: LiveDocEngineConfigSource;
  updatedAt?: string;
  updatedBy?: string;
}

/** Body for `PATCH /admin/harness/live/config` — toggle the kill-switch. */
export interface UpdateLiveDocEngineConfigRequest {
  enabled: boolean;
  reason?: string;
}

/** One-shot SSE ticket (`POST /auth/stream-ticket`). */
export interface StreamTicketResponse {
  ticket: string;
  expiresAt?: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const BASE = '/admin/harness/live';

/** `RequestOptions` carrying the selected tenant only when one is set. */
function tenantOpts(tenantId?: string): RequestOptions | undefined {
  return tenantId ? { tenantId } : undefined;
}

// ---------------------------------------------------------------------------
// SSE plumbing (TASK-341 B5)
// ---------------------------------------------------------------------------

/**
 * Mint a one-shot SSE ticket for `scope` on the admin plane. `EventSource`
 * can't set an `Authorization` header, so the live-summary stream is opened
 * with a short-lived `?ticket=` minted here (admin bearer token + the active
 * `X-Tenant-Id`, which the backend validates against the consultation's tenant
 * at mint time). A super-admin's selected tenant propagates via `tenantId`.
 */
export function fetchStreamTicket(scope: string, tenantId?: string): Promise<StreamTicketResponse> {
  return adminClient.post<StreamTicketResponse>('/auth/stream-ticket', { scope }, tenantOpts(tenantId));
}

/** Build the authenticated live-summary SSE URL (`?ticket=` appended). */
export function buildLiveSummaryStreamUrl(consultationId: string, ticket: string): string {
  const base = adminClient.getBaseUrl();
  return `${base}/consultations/${encodeURIComponent(consultationId)}/live-summary/stream?ticket=${encodeURIComponent(ticket)}`;
}

// ---------------------------------------------------------------------------
// Raw client functions (thin wrappers over adminClient)
// ---------------------------------------------------------------------------

export const liveApi = {
  listSessions: (tenantId?: string) => adminClient.get<LiveDocSessionsList>(`${BASE}/sessions`, tenantOpts(tenantId)),

  getSession: (id: string, tenantId?: string) =>
    adminClient.get<LiveDocSessionStats>(`${BASE}/sessions/${encodeURIComponent(id)}`, tenantOpts(tenantId)),

  getConfig: () => adminClient.get<LiveDocEngineConfig>(`${BASE}/config`),

  updateConfig: (body: UpdateLiveDocEngineConfigRequest) => adminClient.patch<LiveDocEngineConfig>(`${BASE}/config`, body),
};

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const liveKeys = {
  all: ['admin', 'harness', 'live'] as const,
  sessions: (tenantId?: string) => [...liveKeys.all, 'sessions', tenantId ?? null] as const,
  config: () => [...liveKeys.all, 'config'] as const,
};

// ---------------------------------------------------------------------------
// Query / mutation hooks
// ---------------------------------------------------------------------------

type QueryOpts<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

export function useLiveSessions(tenantId?: string, options?: QueryOpts<LiveDocSessionsList>) {
  return useQuery({
    queryKey: liveKeys.sessions(tenantId),
    queryFn: () => liveApi.listSessions(tenantId),
    ...options,
  });
}

export function useLiveEngineConfig(options?: QueryOpts<LiveDocEngineConfig>) {
  return useQuery({
    queryKey: liveKeys.config(),
    queryFn: () => liveApi.getConfig(),
    ...options,
  });
}

export function useUpdateLiveEngineConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLiveDocEngineConfigRequest) => liveApi.updateConfig(body),
    onSuccess: (data) => qc.setQueryData(liveKeys.config(), data),
  });
}
