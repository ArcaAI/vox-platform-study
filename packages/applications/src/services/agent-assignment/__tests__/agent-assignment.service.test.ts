/** TASK-863 — AgentAssignmentService: the department → tenant → SYSTEM cascade, stale-reference skipping, WORM change rows. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AgentTask, PipelinePolicyScope, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AgentAssignmentService } from '../agent-assignment.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const assignmentRepository = {
  findForScope: vi.fn(),
  findForScopeSelector: vi.fn(),
  findAllForScope: vi.fn(),
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
  return new AgentAssignmentService(assignmentRepository as never, changeRepository as never, agentRepository as never, departmentRepository as never, databaseService as never, eventEmitter as never, cls as never);
}

/** A tier read that answers with rows keyed by `(tenantId, scope)` — the shape `findAllForScope` returns. */
function tierRows(rows: Record<string, Array<{ agentSlug: string; selectorKey: string }>>) {
  assignmentRepository.findAllForScope.mockImplementation(async (tenantId: string, scope: string) => rows[`${tenantId}|${scope}`] ?? []);
}

beforeEach(() => vi.clearAllMocks());

describe('resolve', () => {
  it('department override wins when it resolves', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.DEPARTMENT}`]: [{ agentSlug: 'dept-asr', selectorKey: '' }],
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [{ agentSlug: 'tenant-asr', selectorKey: '' }],
    });
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => ({ slug, task: AgentTask.SPEECH_TO_TEXT }));
    expect(await make().resolve(TENANT, AgentTask.SPEECH_TO_TEXT, 'dept-1')).toEqual({ agentSlug: 'dept-asr', source: 'department', selector: [] });
  });

  it('skips a tier whose slug no longer resolves and keeps walking to SYSTEM (never a silent stale serve)', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [{ agentSlug: 'retired-asr', selectorKey: '' }],
      [`${SYSTEM_TENANT_ID}|${PipelinePolicyScope.TENANT}`]: [{ agentSlug: 'platform-transcription', selectorKey: '' }],
    });
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => (slug === 'platform-transcription' ? { slug, task: AgentTask.SPEECH_TO_TEXT } : null));
    expect(await make().resolve(TENANT, AgentTask.SPEECH_TO_TEXT)).toEqual({ agentSlug: 'platform-transcription', source: 'platform-default', selector: [] });
    expect(assignmentRepository.findAllForScope).toHaveBeenCalledWith(SYSTEM_TENANT_ID, PipelinePolicyScope.TENANT, null, AgentTask.SPEECH_TO_TEXT);
  });

  it('nothing assigned anywhere → null', async () => {
    tierRows({});
    expect(await make().resolve(TENANT, AgentTask.TEXT_TO_SPEECH)).toEqual({ agentSlug: null, source: 'platform-default', selector: [] });
  });
});

// TASK-884, owner decision #6 — tenant admins align agents by key:value tags, and an assignment
// may be qualified by a tag SELECTOR. There is no department/visit-type condition anywhere here.
describe('resolve — tag selection within a tier', () => {
  beforeEach(() => {
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => ({ slug, task: AgentTask.TEXT_GENERATION }));
  });

  it('a tag-qualified assignment is matched BEFORE the unqualified one at the same scope', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [
        { agentSlug: 'general-notes', selectorKey: '' },
        { agentSlug: 'rheum-notes', selectorKey: 'specialty:rheumatology' },
      ],
    });
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION, null, ['specialty:rheumatology'])).toEqual({
      agentSlug: 'rheum-notes',
      source: 'tenant',
      selector: ['specialty:rheumatology'],
    });
  });

  it('a request with NO tags resolves exactly what it always did — the unqualified row', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [
        { agentSlug: 'general-notes', selectorKey: '' },
        { agentSlug: 'rheum-notes', selectorKey: 'specialty:rheumatology' },
      ],
    });
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION)).toMatchObject({ agentSlug: 'general-notes', selector: [] });
  });

  it('a non-matching tag falls through to the unqualified row rather than failing', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [
        { agentSlug: 'general-notes', selectorKey: '' },
        { agentSlug: 'rheum-notes', selectorKey: 'specialty:rheumatology' },
      ],
    });
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION, null, ['specialty:cardiology'])).toMatchObject({ agentSlug: 'general-notes', selector: [] });
  });

  it('the MOST SPECIFIC matching selector wins within a tier', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [
        { agentSlug: 'general', selectorKey: '' },
        { agentSlug: 'rheum', selectorKey: 'specialty:rheumatology' },
        { agentSlug: 'rheum-ml', selectorKey: 'lang:ml,specialty:rheumatology' },
      ],
    });
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION, null, ['specialty:rheumatology', 'lang:ml'])).toMatchObject({ agentSlug: 'rheum-ml' });
  });

  it('the TIER order still outranks the selector: a department default beats a tenant tag match', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.DEPARTMENT}`]: [{ agentSlug: 'dept-default', selectorKey: '' }],
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [{ agentSlug: 'rheum-notes', selectorKey: 'specialty:rheumatology' }],
    });
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION, 'dept-1', ['specialty:rheumatology'])).toMatchObject({ agentSlug: 'dept-default', source: 'department' });
  });

  it('a tag-qualified row whose agent no longer resolves is SKIPPED, not served', async () => {
    tierRows({
      [`${TENANT}|${PipelinePolicyScope.TENANT}`]: [
        { agentSlug: 'general-notes', selectorKey: '' },
        { agentSlug: 'retired-rheum', selectorKey: 'specialty:rheumatology' },
      ],
    });
    agentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => (slug === 'retired-rheum' ? null : { slug, task: AgentTask.TEXT_GENERATION }));
    expect(await make().resolve(TENANT, AgentTask.TEXT_GENERATION, null, ['specialty:rheumatology'])).toMatchObject({ agentSlug: 'general-notes' });
  });
});

describe('upsert', () => {
  it('creates the row and its WORM change in one transaction, refusing a slug that is not a published agent of the task', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
    await expect(make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'nope' })).rejects.toBeInstanceOf(BadRequestException);

    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: 'platform-transcription', task: AgentTask.SPEECH_TO_TEXT });
    assignmentRepository.findForScopeSelector.mockResolvedValue(null);
    const created = await make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription', reason: 'go' });
    expect(created.agentSlug).toBe('platform-transcription');
    expect(created.selectorTags).toEqual([]);
    expect(databaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
    expect(changeRepository.create).toHaveBeenCalledTimes(1);
    const change = changeRepository.create.mock.calls[0][0] as { beforeSlug: string | null; afterSlug: string; reason: string; selectorKey: string };
    expect(change).toMatchObject({ beforeSlug: null, afterSlug: 'platform-transcription', reason: 'go', selectorKey: '' });
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('rejects DOCTOR scope', async () => {
    await expect(make().upsert({ scope: PipelinePolicyScope.DOCTOR, scopeId: 'u', task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  // TASK-884
  it('addresses the row by (tier, SELECTOR): a qualified write never overwrites the unqualified assignment', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: 'rheum-notes', task: AgentTask.TEXT_GENERATION });
    assignmentRepository.findForScopeSelector.mockResolvedValue(null);
    const created = await make().upsert({
      scope: PipelinePolicyScope.TENANT,
      task: AgentTask.TEXT_GENERATION,
      agentSlug: 'rheum-notes',
      // Deliberately unsorted: the CANONICAL form is what identifies the row, so `{b,a}` and
      // `{a,b}` are one assignment rather than two competing for the same tier.
      selectorTags: ['specialty:rheumatology', 'lang:ml'],
    });
    expect(assignmentRepository.findForScopeSelector).toHaveBeenCalledWith(TENANT, PipelinePolicyScope.TENANT, null, AgentTask.TEXT_GENERATION, 'lang:ml,specialty:rheumatology');
    expect(created.selectorTags).toEqual(['lang:ml', 'specialty:rheumatology']);
    expect((changeRepository.create.mock.calls[0][0] as { selectorKey: string }).selectorKey).toBe('lang:ml,specialty:rheumatology');
  });

  it('REFUSES a bare selector key rather than dropping it — a dropped tag changes which agent resolves', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue({ slug: 'rheum-notes', task: AgentTask.TEXT_GENERATION });
    await expect(
      make().upsert({ scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: 'rheum-notes', selectorTags: ['rheumatology'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assignmentRepository.create).not.toHaveBeenCalled();
  });
});
