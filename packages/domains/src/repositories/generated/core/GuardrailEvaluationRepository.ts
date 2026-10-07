import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { GuardrailEvaluationEntityMapper } from '../../../mappers';
import { GuardrailEvaluationEntity } from '../../../entities';
import { GuardrailEvaluation } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/** Outcome of {@link GuardrailEvaluationRepository.createManyIdempotent}. */
export interface GuardrailEvaluationBatchResult {
  /** Rows this call inserted. */
  inserted: number;
  /** Rows already stored under the same `evaluationId` (a redriven outbox batch). */
  duplicates: number;
}

/** A monitoring window: `[from, to)`, optionally one tenant (absent = every tenant, the platform view). */
export interface GuardrailEvaluationWindow {
  from: Date;
  to: Date;
  tenantId?: string;
}

export interface GuardrailDecisionSeriesRow {
  bucketStart: Date;
  direction: string;
  decision: string;
  count: number;
}

export interface GuardrailCheckCountRow {
  checkId: string;
  direction: string;
  verdict: string;
  actionTaken: string;
  count: number;
}

export interface GuardrailCategoryCountRow {
  checkId: string;
  category: string;
  count: number;
}

export interface GuardrailTenantActivityRow {
  tenantId: string;
  evaluations: number;
  warn: number;
  block: number;
  unverified: number;
}

export interface GuardrailModelActivityRow {
  model: string;
  checkId: string;
  calls: number;
  flags: number;
  undetermined: number;
  avgLatencyMs: number | null;
}

export interface GuardrailEvaluationDrilldownFilter extends GuardrailEvaluationWindow {
  limit: number;
  /** Wire vocabulary (`warn`, `inbound`, …); mapped to the enum spelling here. */
  decision?: string;
  direction?: string;
  checkId?: string;
  consultationId?: string;
  /** Keyset position: rows strictly before `(at, id)` in `(at desc, id desc)` order. */
  after?: { at: Date; id: string };
}

export interface GuardrailEvaluationDrilldownItem {
  id: string;
  tenantId: string;
  at: Date;
  direction: string;
  decision: string;
  caller: string;
  consultationId: string | null;
  runId: string | null;
  nodeId: string | null;
  agentSlug: string | null;
  exempt: string | null;
  policyVersion: string;
  noticeIds: string[];
  checks: unknown[];
  hasWithheldContent: boolean;
}

export interface GuardrailEvaluationDrilldownPage {
  items: GuardrailEvaluationDrilldownItem[];
  hasMore: boolean;
  /** The keyset position of the last returned row, or `null`. */
  last: { at: Date; id: string } | null;
}

const toCount = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const toNumberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const lower = (value: unknown): string => String(value ?? '').toLowerCase();

/**
 * TASK-1050 — guardrail evaluations (§9.8.2). Append-only audit facts: no soft
 * delete, no update path. Writes are idempotent on the caller-supplied `id`
 * (the `evaluationId`) via {@link createManyIdempotent}, which is what makes
 * guardrail's at-least-once outbox safe to redrive.
 */
@Injectable()
export class GuardrailEvaluationRepository extends Repository<GuardrailEvaluationEntity, GuardrailEvaluation> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'guardrailEvaluation', GuardrailEvaluationEntityMapper.getInstance());
  }

  /**
   * Insert a batch in ONE `createMany` with `skipDuplicates`: an id already
   * stored is skipped, never an error. Pass `tx` to write in the same
   * transaction as the notices and item marking derived from the batch.
   */
  async createManyIdempotent(entities: GuardrailEvaluationEntity[], tx?: Prisma.TransactionClient | any): Promise<GuardrailEvaluationBatchResult> {
    if (entities.length === 0) return { inserted: 0, duplicates: 0 };
    const delegate = tx ? (tx as Record<string, any>).guardrailEvaluation : (this as any).db;
    const mapper = (this as any)._mapper as GuardrailEvaluationEntityMapper;
    const data = entities.map((entity) => removeNullValues(mapper.toPersistence(entity)));
    const { count } = await delegate.createMany({ data, skipDuplicates: true });
    return { inserted: count, duplicates: entities.length - count };
  }

  // ── TASK-1050 W2h — monitoring reads (README §11.3 E) ──────────────────────────────────────────────────
  //
  // Raw SQL: these group ACROSS tenants and unnest the `checks` JSON array, which the tenant-scoped extension
  // and the generated finders cannot express. The deliberate cross-tenant read is gated in the service
  // (platform admin, tenant-less context). Every dimension is a BOUND parameter; nothing reads content — the
  // `checks` array carries none by contract, and the withheld ciphertext is only ever tested for presence.

  private get raw(): { $queryRaw: (query: Prisma.Sql) => Promise<unknown> } {
    return this.unitOfWorkService.getDatabaseService() as unknown as { $queryRaw: (query: Prisma.Sql) => Promise<unknown> };
  }

  private windowWhere(window: GuardrailEvaluationWindow, alias = ''): Prisma.Sql {
    const at = Prisma.raw(`${alias}"at"`);
    const tenant = window.tenantId ? Prisma.sql`AND ${Prisma.raw(`${alias}"tenantId"`)} = ${window.tenantId}` : Prisma.empty;
    return Prisma.sql`${at} >= ${window.from} AND ${at} < ${window.to} ${tenant}`;
  }

  /** Decisions per `(bucket, direction, decision)`. */
  async aggregateDecisionSeries(window: GuardrailEvaluationWindow & { bucketSeconds: number }): Promise<GuardrailDecisionSeriesRow[]> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT date_bin(${`${window.bucketSeconds} seconds`}::interval, "at", TIMESTAMP '2000-01-01') AS "bucketStart",
             "direction"::text AS "direction", "decision"::text AS "decision", COUNT(*) AS "count"
      FROM "core"."GuardrailEvaluation"
      WHERE ${this.windowWhere(window)}
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ bucketStart: row.bucketStart as Date, direction: lower(row.direction), decision: lower(row.decision), count: toCount(row.count) }));
  }

  /** Per-check verdict × action counts (one row per check entry of each evaluation). */
  async aggregateChecks(window: GuardrailEvaluationWindow): Promise<GuardrailCheckCountRow[]> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT c->>'checkId' AS "checkId", e."direction"::text AS "direction", c->>'verdict' AS "verdict",
             c->>'actionTaken' AS "actionTaken", COUNT(*) AS "count"
      FROM "core"."GuardrailEvaluation" e, jsonb_array_elements(e."checks") AS c
      WHERE ${this.windowWhere(window, 'e.')}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3, 4
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      checkId: String(row.checkId),
      direction: lower(row.direction),
      verdict: String(row.verdict),
      actionTaken: String(row.actionTaken),
      count: toCount(row.count),
    }));
  }

  /** The most frequent flagged categories. */
  async topCategories(window: GuardrailEvaluationWindow, limit: number): Promise<GuardrailCategoryCountRow[]> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT c->>'checkId' AS "checkId", c->>'category' AS "category", COUNT(*) AS "count"
      FROM "core"."GuardrailEvaluation" e, jsonb_array_elements(e."checks") AS c
      WHERE ${this.windowWhere(window, 'e.')} AND c->>'verdict' = 'flag' AND c->>'category' IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 3 DESC, 1, 2
      LIMIT ${limit}
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ checkId: String(row.checkId), category: String(row.category), count: toCount(row.count) }));
  }

  /** Evaluations and non-allow decisions per tenant, busiest first. */
  async aggregateByTenant(window: GuardrailEvaluationWindow, limit: number): Promise<GuardrailTenantActivityRow[]> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT "tenantId" AS "tenantId", COUNT(*) AS "evaluations",
             COUNT(*) FILTER (WHERE "decision" = 'WARN') AS "warn",
             COUNT(*) FILTER (WHERE "decision" = 'BLOCK') AS "block",
             COUNT(*) FILTER (WHERE "decision" = 'UNVERIFIED') AS "unverified"
      FROM "core"."GuardrailEvaluation"
      WHERE ${this.windowWhere(window)}
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT ${limit}
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tenantId: String(row.tenantId),
      evaluations: toCount(row.evaluations),
      warn: toCount(row.warn),
      block: toCount(row.block),
      unverified: toCount(row.unverified),
    }));
  }

  /** Per model × check: calls that ran, flags, undetermined, mean latency. `skipped` checks are not calls. */
  async aggregateByModel(window: GuardrailEvaluationWindow): Promise<GuardrailModelActivityRow[]> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT c->>'model' AS "model", c->>'checkId' AS "checkId",
             COUNT(*) FILTER (WHERE c->>'verdict' <> 'skipped') AS "calls",
             COUNT(*) FILTER (WHERE c->>'verdict' = 'flag') AS "flags",
             COUNT(*) FILTER (WHERE c->>'verdict' = 'undetermined') AS "undetermined",
             AVG((c->>'latencyMs')::numeric) FILTER (WHERE c->>'verdict' <> 'skipped') AS "avgLatencyMs"
      FROM "core"."GuardrailEvaluation" e, jsonb_array_elements(e."checks") AS c
      WHERE ${this.windowWhere(window, 'e.')} AND c->>'model' IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1, 2
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      model: String(row.model),
      checkId: String(row.checkId),
      calls: toCount(row.calls),
      flags: toCount(row.flags),
      undetermined: toCount(row.undetermined),
      avgLatencyMs: toNumberOrNull(row.avgLatencyMs),
    }));
  }

  /** Notices resolved `acknowledged` (a SAFETY_OVERRIDE) in the window. */
  async countOverrides(window: GuardrailEvaluationWindow): Promise<number> {
    const tenant = window.tenantId ? Prisma.sql`AND "tenantId" = ${window.tenantId}` : Prisma.empty;
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT COUNT(*) AS "count" FROM "core"."GuardrailNotice"
      WHERE "resolution" = ${'acknowledged'} AND "resolvedAt" >= ${window.from} AND "resolvedAt" < ${window.to} ${tenant}
    `)) as Array<Record<string, unknown>>;
    return toCount(rows[0]?.count);
  }

  /** When the newest evaluation was decided, or `null` when there is none. */
  async latestEvaluationAt(): Promise<Date | null> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`SELECT MAX("at") AS "at" FROM "core"."GuardrailEvaluation"`)) as Array<{ at: Date | null }>;
    return rows[0]?.at ?? null;
  }

  /** Share of check entries that were `undetermined` since `since`; `null` when there were none. */
  async undeterminedShare(since: Date): Promise<number | null> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE c->>'verdict' = 'undetermined') AS "undetermined"
      FROM "core"."GuardrailEvaluation" e, jsonb_array_elements(e."checks") AS c
      WHERE e."at" >= ${since}
    `)) as Array<Record<string, unknown>>;
    const total = toCount(rows[0]?.total);
    return total === 0 ? null : toCount(rows[0]?.undetermined) / total;
  }

  /** One keyset page, newest first. Selects no content: the withheld ciphertext is only tested for presence. */
  async listForDrilldown(filter: GuardrailEvaluationDrilldownFilter): Promise<GuardrailEvaluationDrilldownPage> {
    const clauses: Prisma.Sql[] = [this.windowWhere(filter)];
    if (filter.decision) clauses.push(Prisma.sql`"decision"::text = ${filter.decision.toUpperCase()}`);
    if (filter.direction) clauses.push(Prisma.sql`"direction"::text = ${filter.direction.toUpperCase()}`);
    if (filter.checkId) clauses.push(Prisma.sql`"checks" @> ${JSON.stringify([{ checkId: filter.checkId }])}::jsonb`);
    if (filter.consultationId) clauses.push(Prisma.sql`"consultationId" = ${filter.consultationId}`);
    if (filter.after) clauses.push(Prisma.sql`("at", "id") < (${filter.after.at}, ${filter.after.id})`);
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      SELECT "id", "tenantId", "at", "direction"::text AS "direction", "decision"::text AS "decision", "caller",
             "consultationId", "runId", "nodeId", "agentSlug", "exempt", "policyVersion", "noticeIds", "checks",
             ("encryptedWithheldContent" IS NOT NULL) AS "hasWithheldContent"
      FROM "core"."GuardrailEvaluation"
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY "at" DESC, "id" DESC
      LIMIT ${filter.limit + 1}
    `)) as Array<Record<string, unknown>>;
    const page = rows.slice(0, filter.limit).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenantId),
      at: row.at as Date,
      direction: lower(row.direction),
      decision: lower(row.decision),
      caller: String(row.caller),
      consultationId: (row.consultationId as string | null) ?? null,
      runId: (row.runId as string | null) ?? null,
      nodeId: (row.nodeId as string | null) ?? null,
      agentSlug: (row.agentSlug as string | null) ?? null,
      exempt: (row.exempt as string | null) ?? null,
      policyVersion: String(row.policyVersion),
      noticeIds: Array.isArray(row.noticeIds) ? (row.noticeIds as string[]) : [],
      checks: Array.isArray(row.checks) ? (row.checks as unknown[]) : [],
      hasWithheldContent: row.hasWithheldContent === true,
    }));
    const lastRow = page[page.length - 1];
    return { items: page, hasMore: rows.length > filter.limit, last: lastRow ? { at: lastRow.at, id: lastRow.id } : null };
  }

  /**
   * The evaluation-gap reconciler (§9.8.2): distinct evaluation ids reported on `AgentTrajectoryStep` /
   * `AiActivityRun` (`_metadata.guardrailEvaluationIds`, written by the harness from TEXT's
   * `guardrailEvaluationIds`) created in `[since, olderThan)` that have NO `GuardrailEvaluation` row.
   */
  async countMissingReportedEvaluations(olderThan: Date, since: Date): Promise<number> {
    const rows = (await this.raw.$queryRaw(Prisma.sql`
      WITH reported AS (
        SELECT jsonb_array_elements_text(s."_metadata"->'guardrailEvaluationIds') AS "id"
        FROM "core"."AgentTrajectoryStep" s
        WHERE s."createdAt" >= ${since} AND s."createdAt" < ${olderThan}
          AND jsonb_typeof(s."_metadata"->'guardrailEvaluationIds') = 'array'
        UNION
        SELECT jsonb_array_elements_text(r."_metadata"->'guardrailEvaluationIds') AS "id"
        FROM "core"."AiActivityRun" r
        WHERE r."createdAt" >= ${since} AND r."createdAt" < ${olderThan}
          AND jsonb_typeof(r."_metadata"->'guardrailEvaluationIds') = 'array'
      )
      SELECT COUNT(*) AS "missing"
      FROM reported LEFT JOIN "core"."GuardrailEvaluation" e ON e."id" = reported."id"
      WHERE e."id" IS NULL
    `)) as Array<Record<string, unknown>>;
    return toCount(rows[0]?.missing);
  }

  /** Every evaluation of a consultation in evaluation order. */
  async findByConsultation(tenantId: string, consultationId: string): Promise<GuardrailEvaluationEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, consultationId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    return models.map((model: GuardrailEvaluation) => (this as any)._mapper.toDomainEntity(model));
  }
}
