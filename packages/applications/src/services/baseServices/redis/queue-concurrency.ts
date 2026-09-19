/**
 * BullMQ worker concurrency — one declared number per queue (TASK-993 lane D).
 *
 * Every one of the eleven processors ran at bullmq's DEFAULT concurrency of 1,
 * not by decision but by omission: no `@Processor` passed an options argument.
 * At the 10-tenant x 100-concurrent-user target that makes `AuditLog` — one job
 * per mutation, the highest-volume queue on the platform — a strictly serial
 * pipeline with an unbounded backlog.
 *
 * ## The constraint that decides every number here
 *
 * The eleven workers run INSIDE the gateway process. There is no separate Node
 * worker Deployment: `hope-v2-deployment@main` carries `hope-harness-worker`
 * and `hope-stt-worker`, and both are Python. So a worker slot mid-query and an
 * HTTP request handler mid-query draw from the SAME `PRISMA_PG_MAX`-sized
 * Prisma pool. Raising worker concurrency spends request-handler headroom, and
 * the two must be sized together — which is why the pool arithmetic lives in
 * this file rather than in a comment on `client.ts`.
 *
 * ## Config tier
 *
 * This is NOT a tunable setting and deliberately carries no env var and no
 * `GlobalSetting`. It is a process-construction resource allocation, the same
 * kind of value as the `max` handed to the Prisma driver adapter: the numbers
 * are read once, at class-decoration time, before Nest DI exists and before the
 * database is reachable, so a `db-config` / `global-kv` read is not merely
 * undesirable here but structurally impossible. What the project's config rules
 * forbid is a scattered literal; a single named, derived, test-pinned table is
 * the alternative they ask for. The one knob an operator DOES turn —
 * `PRISMA_PG_MAX` — stays `env`-tier where it already is.
 *
 * Changing a number here is a deliberate act with a budget consequence;
 * `__tests__/queue-concurrency.test.ts` pins the invariant.
 */

import { JobQueue } from '@arcaai/domains';

/**
 * The default `PRISMA_PG_MAX` (`packages/database/src/client.ts`). This is the
 * value that actually applies in the cluster, because the deployment repo sets
 * the variable nowhere — so the budget below must hold at the DEFAULT, not at
 * some value an operator is assumed to have raised.
 */
export const DEFAULT_PRISMA_PG_MAX = 15;

/*
 * Why 15 and not less, now that the load is measured. The measured platform
 * rate (229 req/s) is ~2.9x LOWER than the 667 req/s the ticket first assumed,
 * so the HTTP side of this budget got cheaper — but the binding term is the
 * worker side (6.3 of the 14.3 below), which the measurement does not touch,
 * and {@link HTTP_POOL_RESERVATION} is a BURST budget that a lower steady rate makes
 * more comfortable rather than smaller. Trimming the pool to the new steady
 * figure would be tuning against today's console while the worker table has
 * just gone from 11 serial slots to 39.
 */

/**
 * Pool slots reserved for in-flight HTTP request handlers, which share the pool
 * with the workers below.
 *
 * Derived per gateway pod from the MEASURED platform load — Playwright against
 * the real admin console, not an estimate. A 30% active / 70% parked mix of
 * 1,000 users offers `0.3 x 26.0 + 0.7 x 8.5 = 13.75` req/min each:
 *
 *   1,000 users x 13.75 req/min = 13,750 req/min = 229 req/s
 *   229 req/s / 3 pods          = 76 req/s per pod   (hope-api HPA max is 3)
 *   76 req/s x 6 ms DB time     = 0.46 connections held, steady state
 *   x3 instantaneous spike      = 1.4
 *
 * Reserved at 8 — ~5.7x the modelled spike — and deliberately NOT trimmed to
 * fit it. The spike shape is not smooth: one full document load is 8.0 gateway
 * requests on its own, and the reconnect storm in TASK-993 §2.12 (341
 * reconnects against 33 sessions) shows bursts arriving correlated rather than
 * Poisson. The asymmetry decides the rest: a handler that cannot get a
 * connection within `connectionTimeoutMillis` (5 s) FAILS THE REQUEST, while a
 * worker that cannot simply drains more slowly. HTTP gets the reservation;
 * the workers get the remainder.
 */
export const HTTP_POOL_RESERVATION = 8;

/**
 * Fraction of its wall time a DB-bound worker slot actually holds a connection.
 *
 * A BullMQ slot is not a connection: it holds one only while a query is in
 * flight. Even the most DB-heavy queues here (`AuditLog`: envelope-encrypt, one
 * INSERT) spend most of a job's life on CPU and on BullMQ's own Redis
 * round-trips. 0.35 is a deliberately pessimistic estimate — three times the
 * duty cycle a pure INSERT would show — so the budget holds even if the guess
 * is wrong by 2x.
 */
export const WORKER_DB_DUTY_CYCLE = 0.35;

/**
 * Queues whose jobs are dominated by Postgres work, and therefore the only ones
 * counted against the Prisma pool.
 *
 * The omissions are the point:
 *   - `WebhookDelivery` signs and POSTs to a tenant endpoint — no DB at all.
 *   - the three LLM queues spend essentially all of their wall time awaiting
 *     `apps/text` over HTTP, holding no connection while they wait.
 *   - `DownloadAiModel` is a network + MinIO job with one row written at the end.
 *   - `IngestKnowledgeDocument` is embedding-bound (LM Studio) with a bulk
 *     chunk INSERT at the end; at concurrency 2 it is noise against the others.
 */
export const DB_BOUND_QUEUES = [
  JobQueue.AuditLog,
  JobQueue.SysEvent,
  JobQueue.MineGateEditExemplar,
  JobQueue.SyncTenantDirectoryUsers,
  JobQueue.AiUsageOutboxDrain,
] as const;

/**
 * Concurrency per queue. Every number carries the reason it is that number and
 * not the neighbouring one.
 */
export const QUEUE_CONCURRENCY: Record<string, number> = {
  /**
   * The hot path: every mutation broadcasts a sys-event that enqueues exactly
   * one of these, so this is the highest-volume queue on the platform. At 1,000
   * users x ~5 mutations/min = 83 jobs/s; at ~10 ms per job (envelope-encrypt +
   * one INSERT) that is 0.83 jobs in flight, so 8 is ~10x burst headroom.
   * Serial (the old default) turns an audit backlog into unbounded Redis growth
   * on an instance configured `noeviction`.
   */
  [JobQueue.AuditLog]: 8,

  /**
   * The same arrival rate as `AuditLog` — every mutation fans out here too —
   * but less work per job: match the fired event against subscribed `Webhook`
   * rows and enqueue one `WebhookDelivery` per match. Sized just under its
   * twin for that reason.
   */
  [JobQueue.SysEvent]: 6,

  /**
   * The highest number in the table, and the only queue that holds NO pool
   * slot: it is pure outbound HTTP. This queue exists precisely so one tenant's
   * slow or failing endpoint cannot delay deliveries to every other tenant
   * (see the split rationale in `webhook-delivery.processor.ts`) — a promise
   * concurrency 1 silently broke, since one 30-second timeout blocked the
   * whole platform's webhook traffic.
   */
  [JobQueue.WebhookDelivery]: 10,

  /*
   * The three LLM-backed queues. All three call `apps/text`, which admits
   * 4 concurrent generations per provider on the user lane
   * (`PROVIDER_MAX_CONCURRENT_FLOOR = 4`, `runtime_defaults.py`) and lets a
   * queued call wait at most `queue_max_wait_s = 60` before it gives up.
   * Over-provisioning past that semaphore does not go faster — it converts a
   * queue into a 60-second timeout. 3 + 3 + 2 = 8 keeps the lane saturated with
   * a short standing queue, and splits it by urgency.
   */
  /** Interactive: the clinician is waiting on the pre-summary. */
  [JobQueue.GeneratePreSummary]: 3,
  /** Interactive: post-consultation, same share. */
  [JobQueue.GenerateComprehensiveSummary]: 3,
  /** Background style analysis; smallest share of the shared lane. */
  [JobQueue.GenerateDnaReport]: 2,

  /**
   * Chunk + embed through the self-hosted LM Studio endpoint, then a bulk chunk
   * INSERT. Embedding is GPU work on a card `hope-lmstudio` already claims 4 of
   * the cluster's 6 time-sliced units of — and time-slicing gives no memory
   * isolation, so a third concurrent ingest competes with live inference for
   * VRAM rather than for CPU.
   */
  [JobQueue.IngestKnowledgeDocument]: 2,

  /**
   * Derived-corpus mining, off the clinical path and not latency-sensitive: it
   * runs after a sign-off that has already committed. 2 is enough that a batch
   * of sign-offs drains, and small enough that it never competes with `AuditLog`.
   */
  [JobQueue.MineGateEditExemplar]: 2,

  /**
   * MUST stay 1. Per-user JIT provisioning inside a transaction with a seat-
   * quota check; two concurrent syncs of the SAME tenant would race that check
   * and over-provision past `maxUsers`. Admin-triggered and rare, so serial
   * costs nothing.
   */
  [JobQueue.SyncTenantDirectoryUsers]: 1,

  /**
   * MUST stay 1. A multi-GB fetch -> verify -> MinIO publish running inside the
   * gateway's 2Gi memory limit, onto the node's shared `local-path` disk (no
   * quota is enforced there, so an overrun surfaces as node `DiskPressure`
   * under the DATABASE). Two at once is an OOM kill or a disk-full incident,
   * not a faster download.
   */
  [JobQueue.DownloadAiModel]: 1,

  /**
   * MUST stay 1. Not a work queue: a periodic scheduler TICK
   * (`upsertJobScheduler`) whose job carries no payload and claims whatever
   * outbox rows are due. Concurrent sweeps are safe — idempotency key plus
   * in-database increments — but, in the processor's own words, "would be pure
   * waste and would multiply lock contention".
   */
  [JobQueue.AiUsageOutboxDrain]: 1,
};

/** Sum across every queue — the number of jobs that may run at once in-process. */
export const totalWorkerConcurrency = (): number => Object.values(QUEUE_CONCURRENCY).reduce((sum, n) => sum + n, 0);

/** Sum across {@link DB_BOUND_QUEUES} — the only part that competes for the Prisma pool. */
export const dbBoundWorkerConcurrency = (): number => DB_BOUND_QUEUES.reduce((sum, queue) => sum + QUEUE_CONCURRENCY[queue], 0);
