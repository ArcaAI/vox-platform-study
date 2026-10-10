/**
 * TASK-1059 C-0 / OD-5 / OD-9 — the pre-summary (the legacy generator the
 * `harness-not-supported-for-trigger` decision runs) judges its narrative context — the case notes
 * and the clinic's previous visits — BEFORE the prompt is assembled. Vitals are typed and never
 * judged. An off-scope note is left out; nothing in scope fails the job, unrecoverably, with
 * `CONTENT_BLOCKED_NOT_MEDICAL`; no verdict fails it (retryably) with `GUARDRAIL_UNAVAILABLE`, and
 * TEXT is never called in either case.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { PreSummaryProcessor } from '../pre-summary.processor';
import { TextRequestEnrichmentService } from '../../../../text-request/text-request-enrichment.service';
import { ContextJudgeUnavailableError, type ContextJudgeRequest, type ContextJudgeResult } from '../../../../guardrail-context-judge/IContextMedicalJudgeService';

const TENANT = 'tenant-1';

function judgeOf(offScope: (text: string) => boolean) {
  return {
    judge: vi.fn(async (request: ContextJudgeRequest): Promise<ContextJudgeResult> => {
      const verdicts = request.items.map((entry) => ({ id: entry.id, digest: 'd', inScope: !offScope(entry.text), contextType: 'clinical', confidence: 1, cached: false }));
      const inScopeIds = verdicts.filter((v) => v.inScope).map((v) => v.id);
      return { verdicts, inScopeIds, excludedIds: verdicts.filter((v) => !v.inScope).map((v) => v.id), refused: inScopeIds.length === 0 };
    }),
  };
}

function buildProcessor(judge: { judge: ReturnType<typeof vi.fn> }) {
  const contextItemRepository = {
    findByConsultation: vi.fn().mockResolvedValue([
      { id: 'note-1', content: 'Chest pain for three days.', currentVersionNumber: 2 },
      { id: 'note-2', content: 'Please call my travel agent.', currentVersionNumber: 1 },
    ]),
    findById: vi.fn(),
    // The clinic's stated vitals (typed) and previous visits (narrative).
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) =>
      kindKey === 'vitals'
        ? { id: 'v', content: JSON.stringify({ bloodPressure: '120/80' }) }
        : kindKey === 'previous_case_notes'
          ? { id: 'p', content: JSON.stringify({ notes: [{ date: '2026-03-01', text: 'Seen in March for angina.' }] }) }
          : null,
    ),
    create: vi.fn().mockImplementation(async (entity: { content?: string }) => ({ id: 'ctx-1', consultationId: 'consult-1', guardrailStatus: 'CLEAN', content: entity.content })),
    setGuardrailStatus: vi.fn().mockResolvedValue(undefined),
    encryptContentIntoEntity: vi.fn(),
  };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'PRE-SUMMARY' } }) } };
  const jobService = {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  };
  const assemble = vi.fn().mockResolvedValue({ userPrompt: 'assembled', systemPrompt: 'system', hyperparameters: {}, responseFormat: null, resolvedFrom: 'tenant' });
  const processor = new PreSummaryProcessor(
    jobService as never,
    contextItemRepository as never,
    { findById: vi.fn().mockResolvedValue({ id: 'consult-1', tenantId: TENANT, departmentId: null, parentConsultationId: null, doctorId: 'd-1' }) } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text.test') } as never,
    { resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Pre-Summary', promptId: 'p1' }) } as never,
    { assemble } as never,
    { recordJobStart: vi.fn(() => () => 1), recordWaitingDuration: vi.fn(), recordJobComplete: vi.fn(), recordJobFailed: vi.fn(), recordTextCallDuration: vi.fn() } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() } as never,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma', agentSlug: 'platform-summarization' }) } as never,
    undefined,
    undefined,
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
    undefined,
    undefined,
    undefined,
    judge as never,
  );
  return { processor, httpService, assemble, jobService };
}

const job = { id: 'bull-1', timestamp: Date.now(), data: { jobId: 'job-1', consultationId: 'consult-1', tenantId: TENANT, userId: 'user-1', request: {} } };

describe('PreSummaryProcessor — context medical judge (TASK-1059)', () => {
  it('judges the case notes before assembly and leaves an off-scope note out of the prompt and its regions', async () => {
    const judge = judgeOf((text) => text.includes('travel agent'));
    const { processor, httpService, assemble } = buildProcessor(judge);
    await processor.process(job as never);

    const sent = judge.judge.mock.calls[0]![0] as ContextJudgeRequest;
    expect(sent).toMatchObject({ tenantId: TENANT, consultationId: 'consult-1', requestId: 'job-1' });
    // Vitals are typed (OD-8): never judged.
    expect(sent.items.map((entry) => [entry.id, entry.kind])).toEqual([
      ['note-1', 'case_note'],
      ['note-2', 'case_note'],
      ['background:previous_visits', 'prior_visit'],
    ]);
    expect(JSON.stringify(sent.items)).not.toContain('120/80');

    expect(assemble.mock.calls[0]![0].caseNotes).toEqual(['Chest pain for three days.']);
    const [, body] = httpService.axiosRef.post.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(body.region_items).toEqual({ case_notes: [{ itemId: 'note-1', itemVersion: 2 }] });
  });

  it('fails the job unrecoverably with CONTENT_BLOCKED_NOT_MEDICAL when nothing is in scope, without calling TEXT', async () => {
    const { processor, httpService, jobService } = buildProcessor(judgeOf(() => true));
    const error = await processor.process(job as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain('CONTENT_BLOCKED_NOT_MEDICAL');
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(jobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('CONTENT_BLOCKED_NOT_MEDICAL'));
  });

  it('fails closed (GUARDRAIL_UNAVAILABLE, retryable) when the judge has no verdict', async () => {
    const { processor, httpService } = buildProcessor({ judge: vi.fn(async () => Promise.reject(new ContextJudgeUnavailableError())) });
    const error = await processor.process(job as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain('GUARDRAIL_UNAVAILABLE');
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
  });
});
