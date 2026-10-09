/** TASK-1057 — `workflowAssignment.set` consults the platform reason policy before writing. */
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePolicyScope } from '@arcaai/domains';
import { WorkflowAssignmentService } from '../workflow-assignment.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const assignmentRepository = {
  findForScopeSelector: vi.fn(async () => null),
  create: vi.fn(async (e: unknown) => ({ ...(e as object), id: 'w-new', version: 1, createdAt: new Date(), updatedAt: new Date() })),
  updateWithVersion: vi.fn(),
};
const changeRepository = { create: vi.fn(async (e: unknown) => e) };
const definitions = { findPublishedBySlug: vi.fn(async (_t: string, slug: string) => ({ slug, paletteKey: 'core' })) };
const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never);
}

function make(policy: ActionConfirmationService) {
  const service = new WorkflowAssignmentService(
    assignmentRepository as never,
    changeRepository as never,
    definitions as never,
    {} as never,
    databaseService as never,
    new EventEmitter2(),
    cls as never,
    policy,
  );
  return { service, broadcast: vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn> };
}

const dto = { scope: PipelinePolicyScope.TENANT, paletteKey: 'core', workflowDefinitionSlug: 'radiology-note' };

beforeEach(() => vi.clearAllMocks());

describe('workflowAssignment.set', () => {
  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = make(confirmations());
    await service.upsert(dto as never);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'workflowAssignment.set', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service } = make(confirmations('required'));
    const error = await service.upsert(dto as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowAssignment.set' });
    expect(assignmentRepository.create).not.toHaveBeenCalled();
    expect(changeRepository.create).not.toHaveBeenCalled();
  });
});
