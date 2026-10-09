/** TASK-1057 — `workflowInvariantRule.save` consults the platform rationale policy on create AND update. */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRulePredicateType, WorkflowRuleSeverity } from '@arcaai/domains';
import { WorkflowInvariantRuleService } from '../workflow-invariant-rule.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'u1' } : undefined)), set: vi.fn() };
const events = { emit: vi.fn() };
const repo = { findById: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never);
}

function make(policy: ActionConfirmationService) {
  const service = new WorkflowInvariantRuleService(repo as never, events as never, cls as never, policy);
  return { service, broadcast: vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn> };
}

const createDto = {
  ruleId: 'WF-I-900',
  title: 'No PHI hop skipped',
  predicateType: WorkflowRulePredicateType.REQUIRED_NODE_TYPE,
  predicateConfig: { nodeType: 'consultation.phiHop' },
  severity: WorkflowRuleSeverity.ERROR,
  ruleVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  repo.create.mockImplementation(async (e: unknown) => ({ ...(e as object), id: 'r1', tenantId: 'tenant-1', version: 1, createdAt: new Date(), updatedAt: new Date(), effectiveFrom: new Date() }));
});

describe('workflowInvariantRule.save — create', () => {
  it('passes without a rationale under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = make(confirmations());
    await service.create(createDto as never);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'workflowInvariantRule.save', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before the insert when required and missing', async () => {
    const { service } = make(confirmations('required'));
    const error = await service.create(createDto as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowInvariantRule.save' });
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('workflowInvariantRule.save — update', () => {
  const row = () => ({ id: 'r1', tenantId: 'tenant-1', version: 1, hasChanges: true, changes: { title: 'x' } });

  it('passes without a rationale under the default policy and stamps "not required"', async () => {
    repo.findById.mockResolvedValue(row());
    repo.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => ({ ...(e as object), id: 'r1', version: 2, createdAt: new Date(), updatedAt: new Date(), effectiveFrom: new Date() }));
    const { service, broadcast } = make(confirmations());
    vi.spyOn(service as never, 'assertWritable').mockImplementation(() => undefined);
    vi.spyOn(service as never, 'updateEntity').mockResolvedValue(undefined as never);
    vi.spyOn(service as never, 'assertExpectedVersion').mockImplementation(() => undefined);
    await service.update('r1', { title: 'x', expectedVersion: 1 } as never);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'workflowInvariantRule.save', required: false });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before the write when required and missing', async () => {
    repo.findById.mockResolvedValue(row());
    const { service } = make(confirmations('required'));
    vi.spyOn(service as never, 'assertWritable').mockImplementation(() => undefined);
    const error = await service.update('r1', { title: 'x', expectedVersion: 1 } as never).catch((caught: unknown) => caught);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowInvariantRule.save' });
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });
});
