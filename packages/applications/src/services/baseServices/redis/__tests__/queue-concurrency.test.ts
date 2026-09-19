/*
 * TASK-993 lane D, work item 3 — the BullMQ concurrency budget.
 *
 * Every one of the eleven processors ran at bullmq's default concurrency of 1,
 * because no `@Processor` passed an options argument. At the 10-tenant x
 * 100-user target that makes `AuditLog` — one job per mutation, the
 * highest-volume queue on the platform — a strictly serial pipeline, and its
 * backlog is unbounded.
 *
 * Raising them is not free: the eleven workers live INSIDE the gateway process
 * (there is no separate Node worker Deployment — `hope-v2-deployment@main`
 * carries only `hope-harness-worker` and `hope-stt-worker`, both Python), so a
 * worker slot mid-query and an HTTP request mid-query draw from the SAME
 * `PRISMA_PG_MAX`-sized pool. This file pins that budget so a future
 * concurrency bump cannot silently starve request handlers.
 */
import { describe, expect, it } from 'vitest';
import { JobQueue } from '@arcaai/domains';

import {
  DB_BOUND_QUEUES,
  DEFAULT_PRISMA_PG_MAX,
  HTTP_POOL_RESERVATION,
  QUEUE_CONCURRENCY,
  WORKER_DB_DUTY_CYCLE,
  dbBoundWorkerConcurrency,
  totalWorkerConcurrency,
} from '../queue-concurrency';
import { USAGE_OUTBOX_QUEUE } from '../../../usageLedger/usage-ledger.constants';

describe('BullMQ queue concurrency (TASK-993 lane D)', () => {
  it('declares a concurrency for every queue that has a processor', () => {
    const declared = Object.keys(QUEUE_CONCURRENCY).sort();
    expect(declared).toEqual(
      [
        JobQueue.AuditLog,
        JobQueue.SysEvent,
        JobQueue.WebhookDelivery,
        JobQueue.GeneratePreSummary,
        JobQueue.GenerateComprehensiveSummary,
        JobQueue.GenerateDnaReport,
        JobQueue.IngestKnowledgeDocument,
        JobQueue.MineGateEditExemplar,
        JobQueue.SyncTenantDirectoryUsers,
        JobQueue.DownloadAiModel,
        USAGE_OUTBOX_QUEUE,
      ].sort(),
    );
  });

  it('every concurrency is a positive integer', () => {
    for (const [queue, concurrency] of Object.entries(QUEUE_CONCURRENCY)) {
      expect(Number.isInteger(concurrency), `${queue} = ${concurrency}`).toBe(true);
      expect(concurrency, queue).toBeGreaterThan(0);
    }
  });

  /*
   * The three queues that MUST stay serial, each for a reason the number alone
   * does not carry. A bump here is a correctness regression, not a tuning
   * choice, so it gets its own assertion.
   */
  it('keeps the three single-flight queues at 1', () => {
    // A periodic scheduler tick that claims whatever outbox rows are due. Two
    // concurrent sweeps are safe (idempotency key + in-database increments) but
    // are pure waste and multiply lock contention — see usage-outbox.processor.ts.
    expect(QUEUE_CONCURRENCY[USAGE_OUTBOX_QUEUE]).toBe(1);
    // A multi-GB fetch -> verify -> MinIO publish inside the gateway's 2Gi
    // memory limit, onto the node's shared `local-path` disk.
    expect(QUEUE_CONCURRENCY[JobQueue.DownloadAiModel]).toBe(1);
    // Per-user JIT provisioning with a seat-quota check; two syncs of the same
    // tenant would race that check.
    expect(QUEUE_CONCURRENCY[JobQueue.SyncTenantDirectoryUsers]).toBe(1);
  });

  /*
   * `apps/text` admits 4 concurrent generations per provider on the user lane
   * (`PROVIDER_MAX_CONCURRENT_FLOOR = 4`, `runtime_defaults.py`) and a queued
   * call waits at most `queue_max_wait_s = 60`. The three LLM-backed queues all
   * land on that one semaphore, so over-provisioning them does not go faster —
   * it converts a queue into a 60-second timeout.
   */
  it('keeps the three LLM-backed queues within one text-service provider lane plus one queued job', () => {
    const TEXT_USER_LANE_CONCURRENCY = 4;
    const llm =
      QUEUE_CONCURRENCY[JobQueue.GeneratePreSummary] +
      QUEUE_CONCURRENCY[JobQueue.GenerateComprehensiveSummary] +
      QUEUE_CONCURRENCY[JobQueue.GenerateDnaReport];
    expect(llm).toBeGreaterThanOrEqual(TEXT_USER_LANE_CONCURRENCY);
    expect(llm).toBeLessThanOrEqual(TEXT_USER_LANE_CONCURRENCY * 2);
  });

  /*
   * THE budget invariant. Worker slots and HTTP handlers share one pool, so the
   * DB-bound worker demand must leave room for request traffic at the DEFAULT
   * pool size — the value that applies in the cluster, where nothing sets
   * `PRISMA_PG_MAX` at all.
   */
  it('DB-bound worker demand plus the HTTP reservation fits the default Prisma pool', () => {
    const workerDemand = dbBoundWorkerConcurrency() * WORKER_DB_DUTY_CYCLE;
    expect(workerDemand + HTTP_POOL_RESERVATION).toBeLessThanOrEqual(DEFAULT_PRISMA_PG_MAX);
  });

  it('classifies only queues that actually touch Postgres as DB-bound', () => {
    for (const queue of DB_BOUND_QUEUES) {
      expect(QUEUE_CONCURRENCY, `${queue} is DB-bound but has no concurrency`).toHaveProperty(queue);
    }
    // WebhookDelivery is pure outbound HTTP — it must never be counted against
    // the pool, which is why it carries the highest concurrency in the table.
    expect(DB_BOUND_QUEUES).not.toContain(JobQueue.WebhookDelivery);
    expect(QUEUE_CONCURRENCY[JobQueue.WebhookDelivery]).toBeGreaterThan(QUEUE_CONCURRENCY[JobQueue.AuditLog]);
  });

  it('exposes the totals the ticket reports', () => {
    expect(totalWorkerConcurrency()).toBe(Object.values(QUEUE_CONCURRENCY).reduce((a, b) => a + b, 0));
    expect(dbBoundWorkerConcurrency()).toBe(DB_BOUND_QUEUES.reduce((sum, q) => sum + QUEUE_CONCURRENCY[q], 0));
  });
});
