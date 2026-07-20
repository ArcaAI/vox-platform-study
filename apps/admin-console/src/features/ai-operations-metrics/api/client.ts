/**
 * AI Operations — Metrics client. Gateway-relative paths
 * under the /api/hope BFF proxy. Generation panels hit the aggregate;
 * regeneration / SLA panels still use the harness-admin gate queue.
 */

import { getJson } from '@/shared/api';
import type {
    GateQueue,
    GenerationAggregateResponse,
    GenerationMetricsParams,
    ListSessionsParams,
    ListStepsParams,
    TrajectorySessionsList,
    TrajectoryStepsPage,
} from './types';

const TRAJECTORY = 'admin/agent-trajectory';
const HARNESS = 'admin/harness';

export function listSessions(params?: ListSessionsParams): Promise<TrajectorySessionsList> {
    return getJson(`${TRAJECTORY}/sessions`, params);
}

/** First keyset page of ordered steps (seq asc) for a session. */
export function listSteps(sessionId: string, params?: ListStepsParams): Promise<TrajectoryStepsPage> {
    return getJson(`${TRAJECTORY}/sessions/${encodeURIComponent(sessionId)}/steps`, params);
}

/** Server-side GenerationStats rollup. Default window = last 7d. */
export function getGenerationMetrics(params?: GenerationMetricsParams): Promise<GenerationAggregateResponse> {
    return getJson(`${TRAJECTORY}/metrics/generation`, params);
}

export function getGateQueue(): Promise<GateQueue> {
    return getJson(`${HARNESS}/gate-queue`);
}
