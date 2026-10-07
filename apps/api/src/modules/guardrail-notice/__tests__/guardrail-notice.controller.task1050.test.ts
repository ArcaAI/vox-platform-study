/**
 * TASK-1050 W2e — the business-plane notice routes and the admin evaluation routes are thin shells:
 * the consultation access check first (404 cross-tenant, the owner / manage / service-account write
 * rule for commands), then the service with the If-Match version and the request's credential.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { GuardrailNoticeController } from '../guardrail-notice.controller';
import { AdminGuardrailEvaluationController } from '../admin-guardrail-evaluation.controller';

function build(opts: { writeDenied?: boolean } = {}) {
  const order: string[] = [];
  const access = {
    assertRead: vi.fn(async () => void order.push('assertRead')),
    assertWrite: vi.fn(async () => {
      order.push('assertWrite');
      if (opts.writeDenied) throw new ForbiddenException('Only the assigned doctor can modify this consultation');
    }),
    callerOf: vi.fn(() => ({ userId: 'doctor-1', isMachine: false })),
  };
  const notices = {
    list: vi.fn(async () => (order.push('list'), { consultationId: 'c-1', notices: [] })),
    acknowledge: vi.fn(async () => (order.push('acknowledge'), { noticeId: 'n-1' })),
    resumeHold: vi.fn(async () => (order.push('resume'), { consultationId: 'c-1', released: true })),
  };
  return { controller: new GuardrailNoticeController(access as never, notices as never), access, notices, order };
}

const req = {} as never;

describe('GuardrailNoticeController', () => {
  it('lists after the read check', async () => {
    const h = build();
    await h.controller.list('c-1');
    expect(h.order).toEqual(['assertRead', 'list']);
  });

  it('acknowledges after the write check, with the If-Match version, the named clinician and the request credential', async () => {
    const h = build();
    await h.controller.acknowledge('c-1', 'n-1', { clinicianUserId: 'doctor-2' }, 7, req);
    expect(h.order).toEqual(['assertWrite', 'acknowledge']);
    expect(h.notices.acknowledge).toHaveBeenCalledWith('c-1', 'n-1', {
      expectedVersion: 7,
      clinicianUserId: 'doctor-2',
      caller: { userId: 'doctor-1', isMachine: false },
    });
  });

  it('answers 428 when If-Match is absent (in-process callers that bypass the guard)', async () => {
    const h = build();
    const error = await h.controller.resume('c-1', { noticeId: 'n-1', resolution: 'item_excluded' }, undefined, req).catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(428);
    expect(h.notices.resumeHold).not.toHaveBeenCalled();
  });

  it('resumes after the write check; a shared-patient reader cannot resume (403 before the service)', async () => {
    const h = build();
    await h.controller.resume('c-1', { noticeId: 'n-1', resolution: 'item_excluded' }, 4, req);
    expect(h.notices.resumeHold).toHaveBeenCalledWith(
      'c-1',
      { noticeId: 'n-1', resolution: 'item_excluded' },
      { expectedVersion: 4, caller: { userId: 'doctor-1', isMachine: false } },
    );
    const denied = build({ writeDenied: true });
    await expect(denied.controller.resume('c-1', { noticeId: 'n-1', resolution: 'item_excluded' }, 4, req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.notices.resumeHold).not.toHaveBeenCalled();
  });
});

describe('AdminGuardrailEvaluationController', () => {
  it('passes the list query and the withheld read through to the admin service', async () => {
    const admin = { list: vi.fn(async () => ({ items: [] })), getWithheld: vi.fn(async () => ({ content: 'x' })) };
    const controller = new AdminGuardrailEvaluationController(admin as never);
    await controller.list('c-1', { action: 'block', limit: 5 } as never);
    expect(admin.list).toHaveBeenCalledWith('c-1', { action: 'block', limit: 5 });
    await controller.withheld('c-1', 'e-1');
    expect(admin.getWithheld).toHaveBeenCalledWith('c-1', 'e-1');
  });
});
