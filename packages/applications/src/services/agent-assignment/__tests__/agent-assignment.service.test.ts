/** TASK-863 — AgentAssignmentService: the department → tenant → SYSTEM cascade, stale-reference skipping, WORM change rows. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AgentTask, PipelinePolicyScope, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AgentAssignmentService } from '../agent-assignment.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const assignmentRepository = { findForScope: vi.fn(), findAllVisible: vi.fn(), findById: vi.fn(), create: vi.fn(async (e: unknown) => e), updateWithVersion: vi.fn(), softDelete: vi.fn() };
const changeRepository = { create: vi.fn(async (e: unknown) => e) };
const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const departmentRepository = { findById: vi.fn() };
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)), set: vi.fn() };

function make() {
  return new AgentAssignmentService(assignmentRepository as never, changeRepository as never, agentRepository as never, departmentRepository as never, databaseService as never, eventEmitter as never, cls as never);
}

beforeEach(() => vi.clearAllMocks());

describe('resolve', () => {
  it('department override wins when it resolves', async () => {
    assignmentRepository.findForScope.mockImplementation(async (_t: string, scope: string) => (scope === PipelinePolicyScope.DEPARTMENT ? { agentSlug: 'dept-asr' } : { agentSlug: 'tenant-asr' }));
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => ({ slug, task: AgentTask.SPEECH_TO_TEXT }));
    expect(await make().resolve(TENANT, AgentTask.SPEECH_TO_TEXT, 'dept-1')).toEqual({ agentSlug: 'dept-asr', source: 'department' });
  });

  it('skips a tier whose slug no longer resolves and keeps walking to SYSTEM (never a silent stale serve)', async () => {
    assignmentRepository.findForScope.mockImplementation(async (tenantId: string) => ({ agentSlug: tenantId === SYSTEM_TENANT_ID ? 'platform-transcription' : 'retired-asr' }));
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => (slug === 'platform-transcription' ? { slug, task: AgentTask.SPEECH_TO_TEXT } : null));
    expect(await make().resolve(TENANT, AgentTask.SPEECH_TO_TEXT)).toEqual({ agentSlug: 'platform-transcription', source: 'platform-default' });
    expect(assignmentRepository.findForScope).toHaveBeenCalledWith(SYSTEM_TENANT_ID, PipelinePolicyScope.TENANT, null, AgentTask.SPEECH_TO_TEXT);
  });

  it('nothing assigned anywhere → null', async () => {
    assignmentRepository.findForScope.mockResolvedValue(null);
    expect(await make().resolve(TENANT, AgentTask.TEXT_TO_SPEECH)).toEqual({ agentSlug: null, source: 'platform-default' });
  });
});

describe('upsert', () => {
  it('creates the row and its WORM change in one transaction, refusing a slug that is not a published agent of the task', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
    await expect(make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'nope' })).rejects.toBeInstanceOf(BadRequestException);

    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: 'platform-transcription', task: AgentTask.SPEECH_TO_TEXT });
    assignmentRepository.findForScope.mockResolvedValue(null);
    const created = await make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription', reason: 'go' });
    expect(created.agentSlug).toBe('platform-transcription');
    expect(databaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
    expect(changeRepository.create).toHaveBeenCalledTimes(1);
    const change = changeRepository.create.mock.calls[0][0] as { beforeSlug: string | null; afterSlug: string; reason: string };
    expect(change).toMatchObject({ beforeSlug: null, afterSlug: 'platform-transcription', reason: 'go' });
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('rejects DOCTOR scope', async () => {
    await expect(make().upsert({ scope: PipelinePolicyScope.DOCTOR, scopeId: 'u', task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
