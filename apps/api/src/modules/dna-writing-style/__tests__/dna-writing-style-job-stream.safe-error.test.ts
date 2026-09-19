/**
 * TASK-991 defect 2 — DNA job `error` field must never carry raw internals.
 *
 * `getDnaJobStatus` used to return BullMQ's `job.failedReason` VERBATIM. That field is the
 * `.message` of whatever `DnaWritingStyleProcessor` last threw, and its outer catch-all
 * (`dna-writing-style.processor.ts:538`, `throw error`) rethrows the ORIGINAL error unchanged
 * whenever something unanticipated escaped — a raw Prisma/axios error whose `.message` can carry
 * a container path, the tenant id, the doctor id and the full column list of the failing query.
 * `redactTopology` alone does not catch this (it strips file paths only). `safeJobError` is an
 * ALLOW-LIST that fails closed: only a known, static, user-meaningful domain-failure string
 * (sourced from the processor and pinned in `dna-writing-style-job-stream.ts`) passes through
 * unchanged; anything else — including an internal/Prisma-shaped message — collapses to a fixed
 * generic string.
 *
 * These tests lock BOTH transports the console can use: the poll route (`getDnaJobStatus`,
 * `GET jobs/:jobId`) and the SSE emission (`streamDnaJobStatus`, `GET jobs/:jobId/stream`) — so
 * they can never disagree again about what is safe to ship to the browser. Sibling to
 * `dna-writing-style-job-stream.access.test.ts` (the ownership gate); this file adds coverage
 * without touching that one's assertions.
 */
import { describe, it, expect } from 'vitest';
import { lastValueFrom } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { getDnaJobStatus, streamDnaJobStatus, safeJobError } from '../dna-writing-style-job-stream';

const OWNED = { tenantId: 't-1', doctorId: 'd-1', userId: 'd-1' };
const ACCESS = { tenantId: 't-1', doctorId: 'd-1' };

/** A 'failed' BullMQ job, owned by OWNED, carrying the given `failedReason`. */
function queueWithFailure(failedReason: string) {
  return {
    getJob: async () => ({
      id: '1',
      data: OWNED,
      progress: 0,
      returnvalue: undefined,
      failedReason,
      getState: async () => 'failed',
    }),
  } as never;
}

// A realistic stand-in for what actually reaches `job.failedReason` when something OTHER than a
// guarded early-exit throws: a raw Prisma error message. Verified shape against real Prisma
// `PrismaClientKnownRequestError`/validation text — it interpolates the failing query's `where`
// clause (ids) and the model/method name, and (per the processor's own comment) axios rejections
// on this same path can add a host:port. This literal exercises all three leak vectors the task
// named: a `/` path fragment, `doctorId`, `tenantId`, and the Prisma method name `findMany`.
const RAW_PRISMA_LIKE_REASON =
  "Invalid `prisma.dnaWritingStyleReport.findMany()` invocation in /app/dist/apps/api/src/main.js:42:7\n\n" +
  "Inconsistent column data: Malformed ObjectID: invalid character 'g' found at 2 in \"tenantId='t-1' doctorId='d-1'\".";

const KNOWN_DOMAIN_MESSAGE = 'No approved text samples available for DNA analysis';
const GENERIC_MESSAGE = 'Generation failed';

describe('safeJobError — allow-list gate (unit)', () => {
  it('passes a known domain failure through unchanged', () => {
    expect(safeJobError(KNOWN_DOMAIN_MESSAGE)).toBe(KNOWN_DOMAIN_MESSAGE);
  });

  it('collapses an unrecognized reason to the generic message', () => {
    expect(safeJobError(RAW_PRISMA_LIKE_REASON)).toBe(GENERIC_MESSAGE);
  });

  it('collapses `undefined` to the generic message (fails closed, never throws)', () => {
    expect(safeJobError(undefined)).toBe(GENERIC_MESSAGE);
  });
});

describe('getDnaJobStatus (poll route) — error field is allow-list-safe', () => {
  it('returns the generic string for an internal/Prisma-shaped failure, leaking none of its internals', async () => {
    const res = await getDnaJobStatus(queueWithFailure(RAW_PRISMA_LIKE_REASON), '1', ACCESS);

    expect(res.status).toBe('failed');
    expect(res.error).toBe(GENERIC_MESSAGE);
    expect(res.error).not.toMatch(/\//);
    expect(res.error).not.toContain('doctorId');
    expect(res.error).not.toContain('tenantId');
    expect(res.error).not.toContain('findMany');
  });

  it('returns a known domain message unchanged', async () => {
    const res = await getDnaJobStatus(queueWithFailure(KNOWN_DOMAIN_MESSAGE), '1', ACCESS);

    expect(res.status).toBe('failed');
    expect(res.error).toBe(KNOWN_DOMAIN_MESSAGE);
  });
});

describe('streamDnaJobStatus (SSE emission) — agrees with the poll route', () => {
  it('also collapses an internal/Prisma-shaped failure to the generic string', async () => {
    const last = (await lastValueFrom(streamDnaJobStatus(queueWithFailure(RAW_PRISMA_LIKE_REASON), '1', ACCESS))) as MessageEvent;
    const parsed = JSON.parse(last.data as string) as { jobId: string; error: string };

    expect(last.type).toBe('error');
    expect(parsed.error).toBe(GENERIC_MESSAGE);
    expect(parsed.error).not.toMatch(/\//);
    expect(parsed.error).not.toContain('doctorId');
    expect(parsed.error).not.toContain('tenantId');
    expect(parsed.error).not.toContain('findMany');
  });

  it('also preserves a known domain message unchanged — the two transports never disagree', async () => {
    const last = (await lastValueFrom(streamDnaJobStatus(queueWithFailure(KNOWN_DOMAIN_MESSAGE), '1', ACCESS))) as MessageEvent;
    const parsed = JSON.parse(last.data as string) as { jobId: string; error: string };

    expect(last.type).toBe('error');
    expect(parsed.error).toBe(KNOWN_DOMAIN_MESSAGE);
  });
});
