import { AgentSessionKind } from '@arcaai/domains';
import {
  AgentTrajectorySessionsListResponse,
  AgentTrajectoryStepsPageResponse,
  CreateAgentTrajectoryStepInput,
  GenerationMetricsAggregateResponse,
} from './dto';

/** Filters for the distinct-sessions list (all optional; tenant is explicit). */
export interface ListTrajectorySessionsFilters {
  consultationId?: string;
  kind?: AgentSessionKind;
  /** Inclusive lower bound on `createdAt` (ISO-8601 instant). */
  from?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601 instant). */
  to?: string;
}

/** Filters for the generation-metrics aggregate. */
export interface AggregateGenerationStatsFilters {
  consultationId?: string;
  /** Inclusive lower bound on `createdAt` (ISO-8601 instant). Defaults to now−7d when both absent. */
  from?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601 instant). Defaults to now when both absent. */
  to?: string;
  /**
   * Per-model prices for the $-cost rollup, keyed by the model id
   * the engine reports in `stats.model`. Sourced from `AiModel.metaData.pricing`
   * (data, not schema). Omit and `estimatedCost` stays null: cost is never guessed.
   */
  pricing?: Record<string, { inputPer1k: number; outputPer1k: number; currency?: string }>;
}

/** Offset pagination for the session list. */
export interface ListTrajectorySessionsOptions {
  page?: number;
  limit?: number;
}

/** Keyset pagination + narrowing for the ordered step stream. */
export interface ListTrajectoryStepsOptions {
  /** Narrow to a single run's per-run seq stream (`""` sentinel for non-Temporal). */
  runId?: string;
  /** Opaque keyset cursor (base64url) from a prior page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

/**
 * ingest + read contract for the ordered session
 * trajectory. The apps/api wave wires the internal ingest route and the admin
 * read controller to these methods.
 */
export interface IAgentTrajectoryService {
  /**
   * Batch-append trajectory steps, IDEMPOTENT on the composite unique
   * `(tenantId, sessionId, runId, seq)` — a re-delivered duplicate batch
   * no-ops. Emits NO sys-event (telemetry exemption). After persisting, each
   * step carrying a `consultationId` is republished to the Redis channel
   * `consultation:trajectory:{consultationId}` for the live view.
   */
  recordSteps(steps: CreateAgentTrajectoryStepInput[]): Promise<void>;

  /** Distinct sessions (grouped by kind+sessionId+runId) with counts + first/last timestamps. */
  listSessions(
    tenantId: string,
    filters?: ListTrajectorySessionsFilters,
    options?: ListTrajectorySessionsOptions,
  ): Promise<AgentTrajectorySessionsListResponse>;

  /** Ordered steps for a session (`seq asc`), keyset-paginated. 404-over-403 on cross-tenant. */
  listSteps(tenantId: string, sessionId: string, options?: ListTrajectoryStepsOptions): Promise<AgentTrajectoryStepsPageResponse>;

  /**
   * Bounded rollup of LLM_CALL GenerationStats for admin Metrics.
   * Requires a createdAt window (default last 7 days) and hard-caps scanned rows.
   */
  aggregateGenerationStats(tenantId: string, filters?: AggregateGenerationStatsFilters): Promise<GenerationMetricsAggregateResponse>;

  /** HARD-delete steps older than `now - days` (retention). Returns the count deleted. */
  pruneOlderThan(days: number): Promise<number>;
}

export const IAgentTrajectoryService = Symbol('IAgentTrajectoryService');
