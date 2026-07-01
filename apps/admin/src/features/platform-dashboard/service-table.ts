/**
 * TASK-383 — Platform Monitoring (frame 11) Services-table derivations.
 *
 * Pure functions that turn `useHealthCheck().services` + `useMonitoring().uptime`
 * into the canonical per-service rows the Monitoring "Services" table renders
 * (SERVICE · STATUS · P95 · UPTIME). Status + uptime are REAL; P95 is TARGET and
 * drawn by the page. Reuses the TASK-380 health normalizers; SDK types are
 * type-only so this stays testable under the app's `@arcaai/vox` vitest stub.
 */

import { normalizeServiceHealth, serviceDisplayName, type ServiceHealthState } from '../tenant-dashboard';

/** Re-exported so the Monitoring page can label a {@link ServiceRow.status} from one import. */
export type { ServiceHealthState } from '../tenant-dashboard';

/** Semantic dot/badge role a `StatusDot`/`StatusBadge` can render (subset of `StatusColorRole`). */
export type ServiceHealthRole = 'success' | 'warning' | 'destructive' | 'info' | 'neutral';

const ROLE_BY_STATE: Record<ServiceHealthState, ServiceHealthRole> = {
    healthy: 'success',
    degraded: 'warning',
    unhealthy: 'destructive',
    checking: 'info',
    unknown: 'neutral',
};

/** Map a normalized health state to its semantic status role. */
export function healthStateToRole(state: ServiceHealthState): ServiceHealthRole {
    return ROLE_BY_STATE[state];
}

/** Minimal shape read off each `useHealthCheck().services` entry. */
export interface ServiceHealthInput {
    status?: string;
    version?: string;
    uptime_seconds?: number;
}

/** Minimal shape read off each `useMonitoring().uptime` entry. */
export interface ServiceUptimeInput {
    service: string;
    uptimeSeconds: number;
}

type ServiceMap = Record<string, ServiceHealthInput | null | undefined> | null | undefined;

/** A row in the Monitoring "Services" table. */
export interface ServiceRow {
    /** Canonical health-map key (`api`, `stt`, …). */
    key: string;
    /** Display name (`api` → `API`, `guardrail` → `Guardrail`). */
    name: string;
    status: ServiceHealthState;
    role: ServiceHealthRole;
    /** REAL elapsed uptime in seconds (monitoring `uptimeSeconds`, else health `uptime_seconds`). */
    uptimeSeconds?: number;
}

/**
 * Canonical platform microservices in display order (frame 11). `apiLive` (the
 * gateway liveness probe) is intentionally excluded — it is not a service row.
 */
export const SERVICE_ORDER = ['api', 'stt', 'smr', 'nlp', 'guardrail', 'harness'] as const;

/** Build the fixed, ordered Services rows from the health map + uptime list. */
export function buildServiceRows(services: ServiceMap, uptime?: ServiceUptimeInput[] | null): ServiceRow[] {
    const map = services ?? {};
    const uptimeByKey = new Map<string, number>();
    for (const entry of uptime ?? []) {
        if (entry?.service) uptimeByKey.set(entry.service.toLowerCase(), entry.uptimeSeconds);
    }

    return SERVICE_ORDER.map((key) => {
        const svc = map[key];
        const status = normalizeServiceHealth(svc?.status);
        const uptimeSeconds = uptimeByKey.get(key) ?? svc?.uptime_seconds;
        return {
            key,
            name: serviceDisplayName(key),
            status,
            role: healthStateToRole(status),
            ...(uptimeSeconds != null ? { uptimeSeconds } : {}),
        };
    });
}
