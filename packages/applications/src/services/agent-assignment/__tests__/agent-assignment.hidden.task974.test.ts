/**
 * TASK-974 §5.1 item 4 — a PLATFORM HIDDEN agent is not assignable.
 *
 * An `AgentAssignment` is a tenant saying "this agent serves that task for me". A platform
 * service agent is reached by the ONE service that owns the capability, through its own
 * SYSTEM-pinned read — never through the cascade — so naming it in an assignment is a
 * contradiction, not a configuration.
 *
 * 409, not 400: the caller's request is well formed and the slug is real; what is refused is the
 * RELATIONSHIP. A 400 would read as "you spelled it wrong" and send an admin looking for a typo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { AgentAssignmentService } from '../agent-assignment.service';
import { DNA_WRITING_STYLE_ANALYST_SLUG } from '../../agent/platform-hidden-agents';

const TENANT = '50000000-0000-0000-0000-000000000000';
const assignmentRepository = {
  findForScope: vi.fn(),
  findForScopeSelector: vi.fn(async () => null),
  findAllForScope: vi.fn(async () => []),
  findAllVisible: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(async (e: unknown) => e),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};
const changeRepository = { create: vi.fn(async (e: unknown) => e) };
const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const departmentRepository = { findById: vi.fn() };
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)), set: vi.fn() };

function make() {
  return new AgentAssignmentService(
    assignmentRepository as never,
    changeRepository as never,
    agentRepository as never,
    departmentRepository as never,
    databaseService as never,
    eventEmitter as never,
    cls as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  assignmentRepository.findForScopeSelector.mockResolvedValue(null);
});

describe('AgentAssignmentService.upsert — a hidden slug is refused', () => {
  it('answers 409 and writes NOTHING — not the row, not the WORM change', async () => {
    // The row is real and published in this tenant (the Global playground case); the refusal is
    // about what an assignment MEANS, not about whether the agent resolves.
    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: DNA_WRITING_STYLE_ANALYST_SLUG, task: AgentTask.TEXT_GENERATION });

    await expect(
      make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(assignmentRepository.create).not.toHaveBeenCalled();
    expect(changeRepository.create).not.toHaveBeenCalled();
    expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('refuses it at DEPARTMENT scope too, and on the UPDATE branch of an existing row', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: DNA_WRITING_STYLE_ANALYST_SLUG, task: AgentTask.TEXT_GENERATION });
    departmentRepository.findById.mockResolvedValue({ id: 'dept-1', tenantId: TENANT });
    assignmentRepository.findForScopeSelector.mockResolvedValue({ id: 'a1', agentSlug: 'clinic-summarizer', version: 1, hasChanges: true });

    await expect(
      make().upsert({
        scope: PipelinePolicyScope.DEPARTMENT,
        scopeId: 'dept-1',
        task: AgentTask.TEXT_GENERATION,
        agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(assignmentRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('leaves an ordinary slug alone', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: 'clinic-summarizer', task: AgentTask.TEXT_GENERATION });
    const created = await make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: 'clinic-summarizer' });
    expect(created.agentSlug).toBe('clinic-summarizer');
  });
});
