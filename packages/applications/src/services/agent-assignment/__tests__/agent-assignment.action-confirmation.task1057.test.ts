/** TASK-1057 — `agentAssignment.set` / `.remove` consult the platform reason policy before writing. */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { AgentAssignmentService } from '../agent-assignment.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const assignmentRepository = {
  findForScopeSelector: vi.fn(async () => null),
  findById: vi.fn(),
  create: vi.fn(async (e: unknown) => ({ ...(e as object), id: 'a-new', version: 1, createdAt: new Date(), updatedAt: new Date() })),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};
const changeRepository = { create: vi.fn(async (e: unknown) => e) };
const agentRepository = { findPublishedActiveBySlug: vi.fn(async () => ({ slug: 'clinic-summarizer', task: AgentTask.TEXT_GENERATION })) };
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)), set: vi.fn() };

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
}

function make(policy: ActionConfirmationService) {
  const service = new AgentAssignmentService(
    assignmentRepository as never,
    changeRepository as never,
    agentRepository as never,
    {} as never,
    databaseService as never,
    eventEmitter as never,
    cls as never,
    policy,
  );
  return { service, broadcast: vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn> };
}

const upsertDto = { scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: 'clinic-summarizer' };
const existing = { id: 'a1', tenantId: TENANT, scope: PipelinePolicyScope.TENANT, scopeId: null, task: AgentTask.TEXT_GENERATION, selectorKey: '', agentSlug: 'x', version: 1, createdAt: new Date(), updatedAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  assignmentRepository.findById.mockResolvedValue(existing);
  assignmentRepository.softDelete.mockResolvedValue({ ...existing, version: 2 });
});

describe('agentAssignment.set', () => {
  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = make(confirmations());
    await service.upsert(upsertDto as never);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'agentAssignment.set', required: false });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing, and accepts it when given', async () => {
    const { service } = make(confirmations('required'));
    const error = await service.upsert(upsertDto as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'agentAssignment.set' });
    expect(assignmentRepository.create).not.toHaveBeenCalled();
    expect(changeRepository.create).not.toHaveBeenCalled();
    await expect(service.upsert({ ...upsertDto, reason: 'Switch to the new summarizer' } as never)).resolves.toBeDefined();
  });
});

describe('agentAssignment.remove', () => {
  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = make(confirmations());
    await service.remove('a1', 1);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'agentAssignment.remove', required: false });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before the soft delete when required and missing', async () => {
    const { service } = make(confirmations('required'));
    const error = await service.remove('a1', 1).catch((caught: unknown) => caught);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'agentAssignment.remove' });
    expect(assignmentRepository.softDelete).not.toHaveBeenCalled();
    expect(changeRepository.create).not.toHaveBeenCalled();
  });
});
