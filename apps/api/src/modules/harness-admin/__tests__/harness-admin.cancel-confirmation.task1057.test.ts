/**
 * TASK-1057 — `workflowRun.cancel` consults the platform reason policy AFTER the ownership proof and
 * BEFORE the cancel reaches the harness, and audits the stamp even when no reason was required.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessAdminController } from '../harness-admin.controller';

const opsClient = {
  describeWorkflow: vi.fn(async () => ({ workflowId: 'wf-1', tenantId: 't1' })),
  cancelWorkflow: vi.fn(async () => ({ requested: true })),
};
const cls = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'] } : undefined)),
};
const events = { emit: vi.fn() };

/**
 * A stand-in for `ActionConfirmationService` (its own behaviour is proven in `@arcaai/applications`):
 * same `assert` contract — the audit stamp, or a 400 `CONFIRMATION_REQUIRED` when required and missing.
 * Built from source rather than imported because `apps/api` resolves `@arcaai/applications` to its
 * built `dist/`, which predates the service.
 */
function confirmations(mode: 'required' | 'not-required' = 'not-required') {
  return {
    assert: vi.fn((actionId: string, input: { value?: unknown }) => {
      const required = mode === 'required';
      const provided = typeof input.value === 'string' && input.value.trim().length > 0;
      if (required && !provided) throw new BadRequestException({ code: 'CONFIRMATION_REQUIRED', actionId, kind: 'reason' });
      return { actionId, kind: 'reason', mode, locked: false, required, provided, note: required ? 'reason required' : 'reason not required' };
    }),
  };
}

function make(policy: ReturnType<typeof confirmations>) {
  return new HarnessAdminController(
    {} as never,
    {} as never,
    opsClient as never,
    cls as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    policy as never,
    events as never,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('workflowRun.cancel', () => {
  it('cancels without a reason under the default policy and audits the "not required" stamp', async () => {
    await make(confirmations()).cancelWorkflow('wf-1', {} as never);
    expect(opsClient.cancelWorkflow).toHaveBeenCalled();
    const [, payload] = events.emit.mock.calls[0];
    expect(payload).toMatchObject({
      tenantId: 't1',
      resourceId: 'wf-1',
      forceAuditLog: true,
      data: { action: 'workflowRunCancel', confirmation: { actionId: 'workflowRun.cancel', required: false, note: 'reason not required' } },
    });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before the cancel reaches the harness when required and missing', async () => {
    const error = await make(confirmations('required')).cancelWorkflow('wf-1', {} as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowRun.cancel' });
    expect(opsClient.cancelWorkflow).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('accepts a supplied reason when required', async () => {
    await make(confirmations('required')).cancelWorkflow('wf-1', { reason: 'Stuck on review' } as never);
    expect(opsClient.cancelWorkflow).toHaveBeenCalledWith('wf-1', { tenantId: 't1', reason: 'Stuck on review' });
  });
});
