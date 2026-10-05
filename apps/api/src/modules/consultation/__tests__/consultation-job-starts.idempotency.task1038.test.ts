/**
 * TASK-1038 B3a deliverable 6 — the async SUMMARY and PRE-SUMMARY starts honour the
 * `Idempotency-Key` header: the same key + body is the same job, a different body is a 409.
 * Only the two START handlers are exercised (the controller is built bare, its collaborators
 * stubbed).
 */
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JobIdempotencyService } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';

const TENANT = '10000000-0000-0000-0000-000000000001';

function memoryCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
    eval: vi.fn(async (_s: string, _n: number, key: string, value: string) => {
      if (store.has(String(key))) return store.get(String(key));
      store.set(String(key), String(value));
      return null;
    }),
  };
}

function build() {
  const idempotency = new JobIdempotencyService(memoryCache() as never);
  let n = 0;
  const noteGenerationService = { generate: vi.fn(async () => ({ generator: 'harness', harnessJobId: `harness-doc-${++n}` })) };
  const consultationJobService = {
    registerHarnessNoteJob: vi.fn(),
    runIdempotent: vi.fn((scope, input, create) => idempotency.run(scope, input, create)),
    createPreSummaryJob: vi.fn(async () => ({ jobId: 'pre-1', status: 'PENDING', sseUrl: '', estimatedSeconds: 30 })),
  };
  const controller = Object.create(ConsultationController.prototype) as ConsultationController;
  Object.assign(controller, {
    noteGenerationService,
    consultationJobService,
    cls: { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'doc-1' } : undefined)) },
    logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
    verifyConsultationOwnership: vi.fn(async () => ({ doctorId: 'doc-1', patientId: 'p' })),
  });
  return { controller, noteGenerationService, consultationJobService };
}

describe('POST :id/summary/async — Idempotency-Key', () => {
  it('same key + same body ⇒ the same job; the harness is started once', async () => {
    const { controller, noteGenerationService } = build();
    const a = await controller.generateSummaryAsync('c-1', {} as never, 'key-1');
    const b = await controller.generateSummaryAsync('c-1', {} as never, 'key-1');
    expect(b.jobId).toBe(a.jobId);
    expect(noteGenerationService.generate).toHaveBeenCalledTimes(1);
  });

  it('same key + a different body ⇒ 409', async () => {
    const { controller } = build();
    await controller.generateSummaryAsync('c-1', {} as never, 'key-1');
    await expect(controller.generateSummaryAsync('c-1', { contextItemIds: ['x'] } as never, 'key-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('no key ⇒ every call starts a new job', async () => {
    const { controller, noteGenerationService } = build();
    await controller.generateSummaryAsync('c-1', {} as never);
    await controller.generateSummaryAsync('c-1', {} as never);
    expect(noteGenerationService.generate).toHaveBeenCalledTimes(2);
  });
});

describe('POST :id/summary/pre-summary/async — Idempotency-Key', () => {
  it('forwards the HEADER key (the body field remains a fallback)', async () => {
    const { controller, consultationJobService } = build();
    await controller.generatePreSummaryAsync('c-1', { idempotencyKey: 'body-key' } as never, 'header-key');
    expect(consultationJobService.createPreSummaryJob).toHaveBeenLastCalledWith(
      'c-1',
      TENANT,
      'doc-1',
      expect.any(Object),
      undefined,
      'header-key',
      'doc-1',
    );
    await controller.generatePreSummaryAsync('c-1', { idempotencyKey: 'body-key' } as never);
    expect(consultationJobService.createPreSummaryJob).toHaveBeenLastCalledWith(
      'c-1',
      TENANT,
      'doc-1',
      expect.any(Object),
      undefined,
      'body-key',
      'doc-1',
    );
  });
});
