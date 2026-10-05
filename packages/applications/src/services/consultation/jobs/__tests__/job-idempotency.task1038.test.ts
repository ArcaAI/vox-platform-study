/**
 * TASK-1038 B3a deliverable 6 — `Idempotency-Key` on job starts (summary, pre-summary, ASR
 * transcription), the same contract workflow runs already honour: the same key with the same
 * body is the same job; the same key with a DIFFERENT body is a 409; a concurrent duplicate that
 * arrives while the first is still starting is a 409 too (never a second, billed job).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JobIdempotencyService } from '../job-idempotency.service';

/** A tiny Redis: GET/SET/DEL plus the one EVAL the service uses (claim-or-read). */
function fakeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, value: string) => {
      const prior = store.get(String(key));
      if (prior !== undefined) return prior;
      store.set(String(key), String(value));
      return null;
    }),
  };
}

const scope = { operation: 'summary', tenantId: 't1', principalId: 'u1', key: 'k-1' };

describe('JobIdempotencyService.run', () => {
  it('no key ⇒ always creates', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    const create = vi.fn(async () => ({ jobId: 'a' }));
    await svc.run({ ...scope, key: undefined }, { a: 1 }, create);
    await svc.run({ ...scope, key: undefined }, { a: 1 }, create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('same key + same body ⇒ the SAME job, created once', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    const create = vi.fn(async () => ({ jobId: 'job-1' }));
    const first = await svc.run(scope, { b: 2, a: 1 }, create);
    const second = await svc.run(scope, { a: 1, b: 2 }, create); // key order does not matter
    expect(first).toEqual({ value: { jobId: 'job-1' }, replayed: false });
    expect(second).toEqual({ value: { jobId: 'job-1' }, replayed: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('same key + different body ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    await svc.run(scope, { a: 1 }, async () => ({ jobId: 'job-1' }));
    await expect(svc.run(scope, { a: 2 }, async () => ({ jobId: 'job-2' }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }),
    });
  });

  it('a duplicate that arrives while the first is still starting ⇒ 409 IDEMPOTENCY_KEY_IN_FLIGHT', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    let release!: () => void;
    const slow = svc.run(scope, { a: 1 }, () => new Promise<{ jobId: string }>((resolve) => (release = () => resolve({ jobId: 'j' }))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(svc.run(scope, { a: 1 }, async () => ({ jobId: 'other' }))).rejects.toBeInstanceOf(ConflictException);
    release();
    await slow;
  });

  it('a failed start releases the key so a retry may create', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    await expect(svc.run(scope, { a: 1 }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(svc.run(scope, { a: 1 }, async () => ({ jobId: 'retry' }))).resolves.toEqual({ value: { jobId: 'retry' }, replayed: false });
  });

  it('scopes keys by operation, tenant and principal', async () => {
    const cache = fakeCache();
    const svc = new JobIdempotencyService(cache as never);
    await svc.run(scope, { a: 1 }, async () => ({ jobId: 'mine' }));
    const other = await svc.run({ ...scope, principalId: 'u2' }, { a: 9 }, async () => ({ jobId: 'theirs' }));
    expect(other.value).toEqual({ jobId: 'theirs' });
  });

  it('refuses an unusable key (400) and fails OPEN when Redis is down', async () => {
    const svc = new JobIdempotencyService(fakeCache() as never);
    await expect(svc.run({ ...scope, key: 'has space' }, {}, async () => ({}))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.run({ ...scope, key: 'x'.repeat(256) }, {}, async () => ({}))).rejects.toBeInstanceOf(BadRequestException);
    const down = { get: vi.fn(), setex: vi.fn().mockRejectedValue(new Error('down')), del: vi.fn(), eval: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(new JobIdempotencyService(down as never).run(scope, {}, async () => ({ jobId: 'z' }))).resolves.toEqual({ value: { jobId: 'z' }, replayed: false });
  });

  it('reads a pre-TASK-1038 record (a bare jobId) as a replay of that job', async () => {
    const cache = fakeCache();
    const svc = new JobIdempotencyService(cache as never);
    cache.store.set(svc.redisKey(scope), 'legacy-job');
    await expect(svc.run(scope, { a: 1 }, async () => ({ jobId: 'new' }), (legacy) => ({ jobId: legacy }))).resolves.toEqual({
      value: { jobId: 'legacy-job' },
      replayed: true,
    });
  });
});
