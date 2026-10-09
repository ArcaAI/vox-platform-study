/** TASK-1057 — `workflowReview.decide` consults the platform comment policy before signalling the harness. */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const cls = { get: vi.fn(), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const harness = { decideWorkflowRunReview: vi.fn(async () => ({ signaled: true })) };
const runs = { getRun: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never);
}

function make(policy: ActionConfirmationService) {
  const positional: unknown[] = [{}, harness, runs, config, eventEmitter, cls, ...Array.from({ length: 14 }, () => undefined), policy];
  const service = new (WorkflowExposureService as unknown as new (...args: unknown[]) => WorkflowExposureService)(...positional);
  return { service, broadcast: vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'user-9' } : undefined));
  runs.getRun.mockResolvedValue({ runId: 'run-1', workflowSlug: 'triage', workflowVersionId: 'ver-1' });
});

describe('workflowReview.decide', () => {
  it('passes without a comment under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = make(confirmations());
    await service.decideReview('triage', 'run-1', 'n_review', { decision: 'approved' });
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'workflowReview.decide', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before signalling the harness when required and missing', async () => {
    const { service } = make(confirmations('required'));
    const error = await service.decideReview('triage', 'run-1', 'n_review', { decision: 'approved' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowReview.decide' });
    expect(harness.decideWorkflowRunReview).not.toHaveBeenCalled();
  });
});
