/**
 * TASK-1059 C-0 / OD-5 / OD-8 / OD-9 — the note composer judges the NARRATIVE context it gathered
 * (encounter transcripts, case notes, prior visits, attachment text) before it is combined with the
 * prompt; typed readings (vitals, test results) are never sent. An off-scope item is left out of the
 * plan, nothing in scope refuses with `CONTENT_BLOCKED_NOT_MEDICAL`, and no verdict is a 503.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ContextItemType } from '@arcaai/domains';
import { NoteInputComposerService } from '../note-input-composer.service';
import { estimateCounts, type TokenCountResult } from '../text-token-count.client';
import { ContextJudgeUnavailableError, type ContextJudgeRequest, type ContextJudgeResult } from '../../../guardrail-context-judge/IContextMedicalJudgeService';

const SOAP = [
  { key: 'subjective', title: 'Subjective' },
  { key: 'plan', title: 'Plan' },
];
const exact = async (texts: readonly string[]): Promise<TokenCountResult> => ({ ...estimateCounts(texts), mode: 'exact', id: 'lm-studio:gemma' });
const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));

const segment = (id: string, seq: number, text: string) => ({
  id,
  type: ContextItemType.TRANSCRIPT_SEGMENT,
  content: text,
  currentVersionNumber: 1,
  encounterSeq: 1,
  segmentSeq: seq,
  speaker: 'doctor',
  t0Ms: seq * 1000,
  createdAt: at(seq),
});

/** A judge that marks every item whose text contains `OFFSCOPE` as out of scope. */
function judgeStub() {
  return {
    judge: vi.fn(async (request: ContextJudgeRequest): Promise<ContextJudgeResult> => {
      const verdicts = request.items.map((entry) => ({
        id: entry.id,
        digest: 'd',
        inScope: !entry.text.includes('OFFSCOPE'),
        contextType: 'clinical',
        confidence: 0.9,
        cached: false,
      }));
      const inScopeIds = verdicts.filter((v) => v.inScope).map((v) => v.id);
      return { verdicts, inScopeIds, excludedIds: verdicts.filter((v) => !v.inScope).map((v) => v.id), refused: request.items.length > 0 && inScopeIds.length === 0 };
    }),
  };
}

function service(segments: ReturnType<typeof segment>[], judge: { judge: ReturnType<typeof vi.fn> }) {
  const contextItemRepository = {
    findSegments: vi.fn(async () => segments),
    findTranscripts: vi.fn(async () => []),
    findEncounterArtifact: vi.fn(async () => null),
    findAttachments: vi.fn(async () => []),
    findPreSummaries: vi.fn(async () => []),
    findByType: vi.fn(async () => []),
    findByConsultation: vi.fn(async () => segments),
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) => (kindKey === 'vitals' ? { id: 'vitals-item' } : null)),
    decryptContentFromEntity: vi.fn(),
  };
  const aiModelRepository = {
    findBySlug: vi.fn(async (_t: string, slug: string) => ({ slug, wireModelId: 'gemma', provider: 'lm-studio', metaData: { contextLength: 32768 } })),
    findPlatformDefaultsFor: vi.fn(async () => []),
    findByTaskTypeSharedRead: vi.fn(async () => []),
  };
  const documentTemplates = {
    resolveForGeneration: vi.fn(async () => ({ compiled: { checklist: SOAP.map((s) => ({ ...s, form: 'PROSE', required: false })) } })),
  };
  return new NoteInputComposerService(
    contextItemRepository as never,
    aiModelRepository as never,
    { count: vi.fn(async (texts: readonly string[]) => exact(texts)) } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    documentTemplates as never,
    { getVersionsByChangeReason: vi.fn(async () => []) } as never,
    undefined,
    undefined,
    undefined,
    judge as never,
  );
}

const extras = {
  background: [
    { key: 'previous_visits', label: 'Previous visits stated by the clinic', text: 'Seen in March for asthma.' },
    { key: 'style_reference', label: 'Style reference', text: 'Doctor writes tersely.' },
  ],
  results: [
    { itemId: 'cn-1', versionNumber: 1, text: 'Case note: OFFSCOPE please book a taxi.' },
    { itemId: 'vitals-item', versionNumber: 1, text: 'Measured vitals: BP 120/80' },
  ],
};
const request = { tenantId: 't1', consultationId: 'c1', mode: 'final' as const, model: 'gemma', system: 'SYSTEM', waitForLedgers: false, extras };

describe('NoteInputComposerService — context medical judge (TASK-1059)', () => {
  it('sends only narrative context, and leaves an off-scope item out of the plan', async () => {
    const judge = judgeStub();
    const svc = service([segment('s1', 1, 'Patient reports wheeze at night.')], judge);
    const { plan } = await svc.compose({ ...request, cache: false });

    expect(judge.judge).toHaveBeenCalledTimes(1);
    const sent = judge.judge.mock.calls[0]![0] as ContextJudgeRequest;
    expect(sent.tenantId).toBe('t1');
    expect(sent.items.map((entry) => [entry.id, entry.kind])).toEqual([
      ['encounter:1', 'transcript'],
      ['cn-1', 'case_note'],
      ['background:previous_visits', 'prior_visit'],
    ]);
    // A preview raises no notice: no consultation is named on it.
    expect(sent.consultationId).toBeUndefined();

    const text = JSON.stringify(plan.blocks);
    expect(text).toContain('wheeze at night');
    expect(text).toContain('Seen in March');
    expect(text).toContain('BP 120/80');
    expect(text).not.toContain('book a taxi');
  });

  it('names the consultation (for the OD-9 notice) on a real composition', async () => {
    const realJudge = judgeStub();
    const real = service([segment('s1', 1, 'Chest pain since morning.')], realJudge);
    await real.compose({ ...request, planId: 'plan-2' });
    expect((realJudge.judge.mock.calls[0]![0] as ContextJudgeRequest).consultationId).toBe('c1');
    expect((realJudge.judge.mock.calls[0]![0] as ContextJudgeRequest).requestId).toBe('plan-2');
  });

  it('drops an off-scope encounter transcript', async () => {
    const svc = service([segment('s1', 1, 'OFFSCOPE talking about the cricket match.')], judgeStub());
    const { plan } = await svc.compose({ ...request, extras: { background: extras.background, results: [] }, cache: false });
    expect(JSON.stringify(plan.blocks)).not.toContain('cricket');
  });

  it('refuses with 422 CONTENT_BLOCKED_NOT_MEDICAL when no narrative item is in scope', async () => {
    const svc = service([segment('s1', 1, 'OFFSCOPE weather chat.')], judgeStub());
    const error = await svc.compose({ ...request, extras: { results: extras.results }, cache: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(422);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'CONTENT_BLOCKED_NOT_MEDICAL' });
  });

  it('fails closed with 503 GUARDRAIL_UNAVAILABLE when the judge has no verdict', async () => {
    const judge = { judge: vi.fn(async () => Promise.reject(new ContextJudgeUnavailableError())) };
    const svc = service([segment('s1', 1, 'Cough.')], judge);
    const error = await svc.compose({ ...request, cache: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'GUARDRAIL_UNAVAILABLE' });
  });
});
