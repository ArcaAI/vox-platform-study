/**
 * TASK-968 — `DnaWritingStyleProcessor` must carry the resolved agent's reasoning posture onto
 * the wire, exactly as the live and finalize tiers already do.
 *
 * This is TASK-891 C2's defect, one call site later. `callText` resolved
 * `{ provider, model, generation }` from `HarnessPolicyService.resolveTextSelection()`, kept the
 * first two and DROPPED the third, then called `applyTextRuntimeProfile(textPayload)` with no
 * second argument — a no-op. The agent's `parameters.generation.reasoning` was selected during the
 * cascade and never reached `extra`, so every DNA writing-style extraction ran on the engine's own
 * default. Measured on `gemma-4-e2b-it-qat` (TASK-891): unset costs 5168 ms / 184 reasoning tokens
 * where `minimal` costs 1237 ms / 30.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double): the claim under test is about
 * the body that service builds, so a stub would assert nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  const stamp = (data: Record<string, unknown>, id: string) => ({ ...data, id, createdAt: new Date(), updatedAt: new Date() });
  return {
    ...actual,
    DnaWritingStyleReportFactory: { CreateDnaWritingStyleReport: vi.fn((d: Record<string, unknown>) => ({ ...stamp(d, 'report-1'), isLatest: true, currentVersionNumber: 1 })) },
    DnaWritingStyleVersionFactory: { CreateDnaWritingStyleVersion: vi.fn((d: Record<string, unknown>) => stamp(d, 'version-1')) },
    DnaUsageRecordFactory: { CreateDnaUsageRecord: vi.fn((d: Record<string, unknown>) => stamp(d, 'usage-1')) },
    PromptUsageRecordFactory: { CreatePromptUsageRecord: vi.fn((d: Record<string, unknown>) => stamp(d, 'prompt-usage-1')) },
  };
});

/** The REAL enrichment service — a stubbed one would assert nothing about the body it builds. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildProcessor(generation?: Record<string, unknown>) {
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: {
          task_id: 'task-1',
          status: 'completed',
          content: JSON.stringify({ reportData: { formality: 'high' }, styleText: 'Formal and concise.' }),
          provider: 'lm-studio',
          model: 'resolved-medgemma',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }),
    },
  };

  const processor = new DnaWritingStyleProcessor(
    { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed: vi.fn() } as never,
    { getValueWithDefault: vi.fn(<T,>(_key: string, fallback: T): T => fallback) } as never,
    { findAll: vi.fn() } as never,
    { getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
    { findLatestForDoctor: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'report-1' }), update: vi.fn() } as never,
    { create: vi.fn().mockResolvedValue({ id: 'version-1' }) } as never,
    { create: vi.fn().mockResolvedValue({ id: 'usage-1' }) } as never,
    { create: vi.fn().mockResolvedValue({ id: 'prompt-usage-1' }) } as never,
    { listPromptTemplates: vi.fn().mockResolvedValue([{ id: 'tpl-1', content: 'Analyze writing samples.', category: 'DNA_ANALYSIS' }]) } as never,
    httpService as never,
    { get: vi.fn().mockReturnValue('http://text.test') } as never,
    { recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5)), recordJobComplete: vi.fn(), recordJobFailed: vi.fn(), recordWaitingDuration: vi.fn(), recordTextCallDuration: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn(), run: vi.fn(<T,>(fn: () => T): T => fn()) } as never,
    undefined, // secretsService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma', ...(generation ? { generation } : {}) }) } as never,
    undefined, // configResolver
    undefined, // promptTemplateRepository
    { redact: vi.fn(async (text: string) => text) } as never,
    enrichment() as never, // textRequestEnrichment — REAL
  );

  return { processor, httpService };
}

const job = () =>
  ({
    id: 'job-1',
    timestamp: Date.now(),
    progress: 0,
    updateProgress: vi.fn(),
    data: { jobId: 'job-1', doctorId: 'doctor-1', tenantId: TENANT, userId: 'user-1', textSamples: ['The patient reports chest pain.'] },
  }) as never;

const lastPostBody = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) => httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-968 — DnaWritingStyleProcessor carries the resolved agent`s reasoning posture', () => {
  it('an agent that disabled reasoning instructs the engine not to reason', async () => {
    const { processor, httpService } = buildProcessor({ temperature: 0.1, reasoning: { enabled: false } });

    await processor.process(job());

    expect(lastPostBody(httpService).reasoning, 'the agent`s reasoning posture never reached the wire').toEqual({ enabled: false });
  });

  it('an agent that named an effort sends that effort', async () => {
    const { processor, httpService } = buildProcessor({ reasoning: { enabled: true, effort: 'medium' } });

    await processor.process(job());

    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('an agent with no reasoning opinion sends no `reasoning` key at all', async () => {
    const { processor, httpService } = buildProcessor({ temperature: 0.1 });

    await processor.process(job());

    expect(Object.keys(lastPostBody(httpService))).not.toContain('extra');
  });
});
