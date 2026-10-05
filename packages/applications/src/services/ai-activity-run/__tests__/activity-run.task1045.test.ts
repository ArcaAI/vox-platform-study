/**
 * The AI activity run record — producer, co-writers and reader.
 *
 * Pins four things:
 *  - `record` is an idempotent upsert on `runKey` that keeps ids, enums and
 *    numbers only (anything shaped like free text is dropped, never stored);
 *  - every LLM_CALL / NODE trajectory step that declares an `activity_kind`
 *    co-writes ONE run record in the SAME transaction as its usage rows, with
 *    deployment / cost basis copied from the usage event;
 *  - a synchronous TEXT call maps to one run record;
 *  - `findProducerOf` resolves a note version directly, a transcript through
 *    its `sttRunKey`, a recap through its ledger, an entity through its parent
 *    item's NER run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  AiActivityKind,
  AiActivityRunFactory,
  AiActivityRunStatus,
  AiCostBasis,
  AiDeploymentKind,
  ContextItemType,
} from '@arcaai/domains';

import { AgentTrajectoryService } from '../../agent-trajectory/agent-trajectory.service';
import type { CreateAgentTrajectoryStepInput } from '../../agent-trajectory/dto';
import { buildTextActivityRun, parseTextUsageDetail } from '../../consultation/summary/text-usage';
import { ActivityRunMapper } from '../activity-run.mapper';
import { AiActivityRunService } from '../ai-activity-run.service';
import type { AiActivityRunInput } from '../IAiActivityRunService';

const TENANT = 'tenant-1';
const CONSULTATION = 'cons-1';

function runInput(overrides: Partial<AiActivityRunInput> = {}): AiActivityRunInput {
  return {
    tenantId: TENANT,
    runKey: 'trajectory:wf-1:run-1:3',
    consultationId: CONSULTATION,
    activityKind: AiActivityKind.NOTE_GENERATE,
    status: AiActivityRunStatus.OK,
    startedAt: new Date('2026-10-05T10:00:00.000Z'),
    ...overrides,
  };
}

function runEntity(overrides: Partial<AiActivityRunInput> = {}) {
  return AiActivityRunFactory.CreateAiActivityRun(ActivityRunMapper.toCreateProps(runInput(overrides))!);
}

// ── the producer ─────────────────────────────────────────────────────────────

describe('AiActivityRunService.record', () => {
  const repository = { upsertByRunKey: vi.fn(), findByRunKey: vi.fn(), findByConsultation: vi.fn(), findProducerOf: vi.fn(), findAll: vi.fn() };
  const service = () => new AiActivityRunService(repository as never, {} as never, {} as never);

  beforeEach(() => {
    vi.clearAllMocks();
    repository.upsertByRunKey.mockImplementation(async (entity) => entity);
  });

  it('upserts one entity keyed by runKey, inside the caller’s transaction', async () => {
    const tx = { marker: 'tx' };
    await service().record(runInput({ tokensIn: 120, tokensOut: 40, costMicros: 15n }), tx);

    expect(repository.upsertByRunKey).toHaveBeenCalledTimes(1);
    const [entity, passedTx] = repository.upsertByRunKey.mock.calls[0];
    expect(passedTx).toBe(tx);
    expect(entity.runKey).toBe('trajectory:wf-1:run-1:3');
    expect(entity.tenantId).toBe(TENANT);
    expect(entity.tokensIn).toBe(120);
    expect(entity.tokensOut).toBe(40);
    expect(entity.costMicros).toBe(15n);
  });

  it('keeps ids and codes but drops anything shaped like free text', async () => {
    await service().record(
      runInput({
        model: 'gemma-4-e2b-it-qat',
        provider: 'lm-studio',
        stopReason: 'the patient said stop',
        errorCode: 'NOTE_INPUT_EXCEEDS_CONTEXT',
        agentSlug: 'soap finalizer with spaces',
        budgetStrategy: 'single_pass',
      }),
    );
    const [entity] = repository.upsertByRunKey.mock.calls[0];
    expect(entity.model).toBe('gemma-4-e2b-it-qat');
    expect(entity.provider).toBe('lm-studio');
    expect(entity.errorCode).toBe('NOTE_INPUT_EXCEEDS_CONTEXT');
    expect(entity.budgetStrategy).toBe('single_pass');
    expect(entity.stopReason).toBeNull();
    expect(entity.agentSlug).toBeNull();
  });

  it('drops unknown enum values and non-finite / negative numbers', async () => {
    await service().record(runInput({ deployment: 'ON_PREM', costBasis: 'BYOK_NOTIONAL', tokensIn: -3, durationMs: Number.NaN, callIndex: 2 }));
    const [entity] = repository.upsertByRunKey.mock.calls[0];
    expect(entity.deployment).toBeNull();
    expect(entity.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(entity.tokensIn).toBeNull();
    expect(entity.durationMs).toBeNull();
    expect(entity.callIndex).toBe(2);
  });

  it('refuses a runKey that is not <producer>:<sessionId>:<runId>:<seq>', async () => {
    await expect(service().record(runInput({ runKey: 'trajectory:wf-1' }))).rejects.toThrow(/runKey/);
    await expect(service().record(runInput({ runKey: 'trajectory:wf-1:run-1:x' }))).rejects.toThrow(/runKey/);
    expect(repository.upsertByRunKey).not.toHaveBeenCalled();
  });

  it('accepts the empty run-id sentinel of a non-Temporal session', async () => {
    await service().record(runInput({ runKey: 'trajectory:live-1::0' }));
    expect(repository.upsertByRunKey).toHaveBeenCalledTimes(1);
  });
});

// ── the trajectory co-writer ─────────────────────────────────────────────────

describe('AgentTrajectoryService.recordSteps → run records', () => {
  const stepRepository = { createMany: vi.fn(), findAll: vi.fn(), delete: vi.fn(), listSessionSummaries: vi.fn() };
  const usageLedger = { recordUsage: vi.fn() };
  const activityRuns = { record: vi.fn() };
  const tx = { marker: 'tx' };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (t: unknown) => unknown) => work(tx)) };
  const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn() };

  const makeService = (withUnitOfWork = true) =>
    new AgentTrajectoryService(
      stepRepository as never,
      { emit: vi.fn() } as never,
      cls as never,
      undefined,
      usageLedger as never,
      (withUnitOfWork ? unitOfWork : undefined) as never,
      undefined,
      undefined,
      activityRuns as never,
    );

  const RUN_STATS = {
    provider: 'lm-studio',
    model: 'gemma-4-e2b-it-qat',
    prompt_tokens: 9000,
    predicted_tokens: 1200,
    stop_reason: 'stop',
    activity_kind: 'NOTE_SECTION_GROUP',
    encounter_seq: 2,
    agent_slug: 'soap-finalizer',
    agent_version: 4,
    prompt_template_id: 'pt-1',
    prompt_version: 3,
    workflow_slug: 'arcaai-consultation',
    workflow_version: 7,
    context_window: 32768,
    max_tokens: 6144,
    budget_strategy: 'section_groups',
    call_index: 1,
    call_count: 3,
    context_item_id: 'note-1',
    output_version: 5,
    plan_id: 'plan-9',
  };

  function step(overrides: Partial<CreateAgentTrajectoryStepInput> = {}): CreateAgentTrajectoryStepInput {
    return {
      tenantId: TENANT,
      consultationId: CONSULTATION,
      sessionKind: AgentSessionKind.HARNESS_DOC,
      sessionId: 'wf-1',
      runId: 'run-1',
      seq: 3,
      stepType: AgentStepType.LLM_CALL,
      name: 'generate',
      status: AgentStepStatus.OK,
      startedAt: new Date('2026-10-05T10:00:00.000Z'),
      endedAt: new Date('2026-10-05T10:00:04.000Z'),
      durationMs: 4000,
      nodeId: 'finalize',
      stats: { ...RUN_STATS },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stepRepository.createMany.mockResolvedValue({ count: 1 });
    usageLedger.recordUsage.mockResolvedValue({ outboxIds: ['ob-1'], events: 1 });
    activityRuns.record.mockResolvedValue(undefined);
    unitOfWork.runInTransaction.mockImplementation(async (work: (t: unknown) => unknown) => work(tx));
  });

  it('co-writes one run record per LLM_CALL step in the same transaction as its usage rows', async () => {
    await makeService().recordSteps([step()]);

    expect(unitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    expect(usageLedger.recordUsage.mock.calls[0][1]).toBe(tx);
    expect(activityRuns.record).toHaveBeenCalledTimes(1);
    const [input, passedTx] = activityRuns.record.mock.calls[0];
    expect(passedTx).toBe(tx);
    expect(input).toMatchObject({
      tenantId: TENANT,
      runKey: 'trajectory:wf-1:run-1:3',
      consultationId: CONSULTATION,
      encounterSeq: 2,
      activityKind: AiActivityKind.NOTE_SECTION_GROUP,
      status: AiActivityRunStatus.OK,
      workflowSlug: 'arcaai-consultation',
      workflowVersion: 7,
      workflowRunId: 'run-1',
      nodeId: 'finalize',
      agentSlug: 'soap-finalizer',
      agentVersion: 4,
      promptTemplateId: 'pt-1',
      promptVersion: 3,
      model: 'gemma-4-e2b-it-qat',
      provider: 'lm-studio',
      deployment: AiDeploymentKind.SELF_HOSTED,
      durationMs: 4000,
      tokensIn: 9000,
      tokensOut: 1200,
      contextUsed: 10200,
      contextWindow: 32768,
      outputCap: 6144,
      stopReason: 'stop',
      budgetStrategy: 'section_groups',
      callIndex: 1,
      callCount: 3,
      contextItemId: 'note-1',
      outputVersionNumber: 5,
      usageRequestId: 'harness:step:wf-1:run-1:3',
    });
    expect(input.planId).toBe('plan-9');
  });

  it('copies the BYOK cost basis from the usage event', async () => {
    await makeService().recordSteps([step({ stats: { ...RUN_STATS, provider: 'openai', funding_tier: 'tenant' } })]);
    const [input] = activityRuns.record.mock.calls[0];
    expect(input.deployment).toBe(AiDeploymentKind.BYOK);
    expect(input.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });

  it('records a NODE step (no usage row) and ignores every other step type, an undeclared kind, and an unfinished step', async () => {
    await makeService().recordSteps([
      step({ seq: 0, stepType: AgentStepType.NODE, name: 'finalize', stats: { activity_kind: 'NOTE_GENERATE', call_count: 3 } }),
      step({ seq: 1, stepType: AgentStepType.TOOL_CALL }),
      step({ seq: 2, stats: { provider: 'lm-studio', prompt_tokens: 10, predicted_tokens: 2 } }),
      step({ seq: 4, status: AgentStepStatus.STARTED }),
      step({ seq: 5, stats: { ...RUN_STATS, activity_kind: 'NOT_A_KIND' } }),
    ]);

    expect(activityRuns.record).toHaveBeenCalledTimes(1);
    const [input] = activityRuns.record.mock.calls[0];
    expect(input.runKey).toBe('trajectory:wf-1:run-1:0');
    expect(input.activityKind).toBe(AiActivityKind.NOTE_GENERATE);
    expect(input.deployment ?? null).toBeNull();
    expect(input.callCount).toBe(3);
  });

  it('maps step status onto run status', async () => {
    await makeService().recordSteps([step({ status: AgentStepStatus.TIMEOUT, errorCode: 'ENGINE_TIMEOUT' })]);
    const [input] = activityRuns.record.mock.calls[0];
    expect(input.status).toBe(AiActivityRunStatus.TIMEOUT);
    expect(input.errorCode).toBe('ENGINE_TIMEOUT');
  });

  it('re-records a re-delivered batch under the SAME runKey (the upsert makes it one row)', async () => {
    const service = makeService();
    await service.recordSteps([step()]);
    stepRepository.createMany.mockResolvedValue({ count: 0 });
    await service.recordSteps([step()]);

    expect(activityRuns.record).toHaveBeenCalledTimes(2);
    expect(activityRuns.record.mock.calls[0][0].runKey).toBe(activityRuns.record.mock.calls[1][0].runKey);
  });

  it('never fails the trajectory ingest when the run record cannot be written', async () => {
    activityRuns.record.mockRejectedValue(new Error('db down'));
    await expect(makeService().recordSteps([step()])).resolves.toBeUndefined();
    expect(stepRepository.createMany).toHaveBeenCalledTimes(1);
  });

  it('records without a transaction when no unit of work is wired', async () => {
    await makeService(false).recordSteps([step()]);
    expect(activityRuns.record).toHaveBeenCalledTimes(1);
    expect(activityRuns.record.mock.calls[0][1]).toBeUndefined();
  });

  it('puts no free text from the stats onto the record', async () => {
    await makeService().recordSteps([step({ stats: { ...RUN_STATS, prompt: 'Patient reports chest pain', output: 'SOAP …' } })]);
    const [input] = activityRuns.record.mock.calls[0];
    expect(JSON.stringify(input)).not.toContain('chest pain');
    expect(JSON.stringify(input)).not.toContain('SOAP');
  });
});

// ── synchronous TEXT calls ───────────────────────────────────────────────────

describe('buildTextActivityRun (one record per synchronous TEXT call)', () => {
  const usage = parseTextUsageDetail({
    task_id: 'task-77',
    request_id: 'req-1',
    provider: 'openai',
    model: 'gpt-5-mini',
    endpoint_kind: 'openai.chat',
    byok: true,
    occurred_at: '2026-10-05T10:00:05.000Z',
    prompt_tokens: 800,
    completion_tokens: 200,
    total_ms: 1500,
  })!;

  it('maps the usage block onto one record keyed by the TEXT task id', () => {
    const input = buildTextActivityRun({
      usage,
      tenantId: TENANT,
      consultationId: CONSULTATION,
      activityKind: AiActivityKind.PRE_SUMMARY,
      contextItemId: 'pre-1',
      outputVersionNumber: 1,
    })!;

    expect(input).toMatchObject({
      tenantId: TENANT,
      runKey: `text:${CONSULTATION}:task-77:0`,
      consultationId: CONSULTATION,
      activityKind: AiActivityKind.PRE_SUMMARY,
      status: AiActivityRunStatus.OK,
      model: 'gpt-5-mini',
      provider: 'openai',
      deployment: AiDeploymentKind.BYOK,
      costBasis: AiCostBasis.BYOK_NOTIONAL,
      tokensIn: 800,
      tokensOut: 200,
      durationMs: 1500,
      contextItemId: 'pre-1',
      outputVersionNumber: 1,
      usageRequestId: 'llm:task-77',
    });
    expect(input.endedAt?.toISOString()).toBe('2026-10-05T10:00:05.000Z');
    expect(input.startedAt.toISOString()).toBe('2026-10-05T10:00:03.500Z');
  });

  it('marks an interrupted call DEGRADED and returns null without a task id', () => {
    const interrupted = { ...usage, interrupted: true };
    expect(buildTextActivityRun({ usage: interrupted, tenantId: TENANT, activityKind: AiActivityKind.NOTE_GENERATE })!.status).toBe(
      AiActivityRunStatus.DEGRADED,
    );
    expect(
      buildTextActivityRun({ usage: { ...usage, taskId: '', requestId: null }, tenantId: TENANT, activityKind: AiActivityKind.NOTE_GENERATE }),
    ).toBeNull();
  });
});

// ── the reader ───────────────────────────────────────────────────────────────

describe('AiActivityRunService as IActivityRunRecordReader', () => {
  const repository = { upsertByRunKey: vi.fn(), findByRunKey: vi.fn(), findByConsultation: vi.fn(), findProducerOf: vi.fn(), findAll: vi.fn() };
  const contextItems = { findByIdOrNull: vi.fn() };
  const namedEntities = { findByIdOrNull: vi.fn() };
  const reader = () => new AiActivityRunService(repository as never, contextItems as never, namedEntities as never);

  const item = (type: ContextItemType, metaData: Record<string, unknown> | null = null, overrides: Record<string, unknown> = {}) => ({
    id: 'item-1',
    tenantId: TENANT,
    consultationId: CONSULTATION,
    type,
    currentVersionNumber: 3,
    metaData,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    repository.findProducerOf.mockResolvedValue(null);
    repository.findByRunKey.mockResolvedValue(null);
    repository.findAll.mockResolvedValue([]);
    namedEntities.findByIdOrNull.mockResolvedValue(null);
  });

  it('resolves a note version directly by (contextItemId, versionNumber)', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.RAW_SUMMARY));
    repository.findProducerOf.mockResolvedValue(
      runEntity({ contextItemId: 'item-1', outputVersionNumber: 2, agentSlug: 'soap-finalizer', model: 'gemma' }),
    );

    const producer = await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1', versionNumber: 2 });

    expect(repository.findProducerOf).toHaveBeenCalledWith({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      contextItemId: 'item-1',
      versionNumber: 2,
    });
    expect(producer).toMatchObject({ activityKind: AiActivityKind.NOTE_GENERATE, agentSlug: 'soap-finalizer', modelName: 'gemma' });
    expect(producer!.activityRunId).toEqual(expect.any(String));
  });

  it('resolves the latest producing run when no versionNumber is given', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.RAW_SUMMARY));
    await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' });
    expect(repository.findProducerOf).toHaveBeenCalledWith({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      contextItemId: 'item-1',
      versionNumber: null,
    });
  });

  it('resolves a transcript segment to its STT run through metaData.sttRunKey', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.TRANSCRIPT_SEGMENT, { sttRunKey: 'stt:sess-1::0' }));
    repository.findByRunKey.mockResolvedValue(runEntity({ runKey: 'stt:sess-1::0', activityKind: AiActivityKind.TRANSCRIBE_STREAM }));

    const producer = await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' });

    expect(repository.findByRunKey).toHaveBeenCalledWith('stt:sess-1::0');
    expect(producer!.activityKind).toBe(AiActivityKind.TRANSCRIBE_STREAM);
    expect(repository.findProducerOf).not.toHaveBeenCalled();
  });

  it('resolves a full transcript version through the item’s sttRunKey, whatever the version', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.FULL_TRANSCRIPT, { sttRunKey: 'stt:sess-2::0' }));
    repository.findByRunKey.mockResolvedValue(runEntity({ runKey: 'stt:sess-2::0', activityKind: AiActivityKind.TRANSCRIBE_STREAM }));

    const producer = await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1', versionNumber: 2 });

    expect(repository.findByRunKey).toHaveBeenCalledWith('stt:sess-2::0');
    expect(producer!.activityKind).toBe(AiActivityKind.TRANSCRIBE_STREAM);
  });

  it('never returns another tenant’s STT run', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.TRANSCRIPT_SEGMENT, { sttRunKey: 'stt:sess-1::0' }));
    repository.findByRunKey.mockResolvedValue(runEntity({ runKey: 'stt:sess-1::0', tenantId: 'tenant-2' }));
    await expect(reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' })).resolves.toBeNull();
  });

  it('answers null for a transcript with no sttRunKey rather than guessing', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.FULL_TRANSCRIPT, {}));
    await expect(reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' })).resolves.toBeNull();
    expect(repository.findProducerOf).not.toHaveBeenCalled();
  });

  it('resolves a recap to the ledger run through ledgerItemId + ledgerVersion', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(
      item(ContextItemType.ENCOUNTER_RECAP, { ledgerItemId: 'ledger-1', ledgerVersion: 2, renderer: 'recap.v1' }),
    );
    repository.findProducerOf.mockResolvedValue(
      runEntity({ activityKind: AiActivityKind.FACT_LEDGER, contextItemId: 'ledger-1', outputVersionNumber: 2 }),
    );

    const producer = await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' });

    expect(repository.findProducerOf).toHaveBeenCalledWith({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      contextItemId: 'ledger-1',
      versionNumber: 2,
    });
    expect(producer!.activityKind).toBe(AiActivityKind.FACT_LEDGER);
  });

  it('resolves an entity to its parent item’s NER run', async () => {
    contextItems.findByIdOrNull.mockImplementation(async (id: string) =>
      id === 'parent-1' ? item(ContextItemType.NAMED_ENTITY, null, { id: 'parent-1' }) : null,
    );
    namedEntities.findByIdOrNull.mockResolvedValue({ id: 'ent-1', tenantId: TENANT, contextItemId: 'parent-1' });
    repository.findAll.mockResolvedValue([runEntity({ activityKind: AiActivityKind.NER, contextItemId: 'parent-1' })]);

    const producer = await reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'ent-1' });

    expect(repository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'parent-1', activityKind: AiActivityKind.NER },
      }),
    );
    expect(producer!.activityKind).toBe(AiActivityKind.NER);
  });

  it('answers null for an item of another consultation or tenant', async () => {
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.RAW_SUMMARY, null, { consultationId: 'cons-other' }));
    await expect(reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' })).resolves.toBeNull();
    contextItems.findByIdOrNull.mockResolvedValue(item(ContextItemType.RAW_SUMMARY, null, { tenantId: 'tenant-2' }));
    await expect(reader().findProducerOf({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: 'item-1' })).resolves.toBeNull();
    expect(repository.findProducerOf).not.toHaveBeenCalled();
  });

  it('lists every run of a consultation in start order', async () => {
    repository.findByConsultation.mockResolvedValue([
      runEntity({ runKey: 'a:s:r:0' }),
      runEntity({ runKey: 'a:s:r:1', activityKind: AiActivityKind.NER }),
    ]);
    const runs = await reader().listForConsultation({ tenantId: TENANT, consultationId: CONSULTATION });
    expect(repository.findByConsultation).toHaveBeenCalledWith(TENANT, CONSULTATION);
    expect(runs.map((run) => run.activityKind)).toEqual([AiActivityKind.NOTE_GENERATE, AiActivityKind.NER]);
  });
});

// ── the console DTOs ─────────────────────────────────────────────────────────

describe('ActivityRunMapper → RunSummary / ActivityRunRecord', () => {
  it('renames the columns onto the wire names', () => {
    const entity = runEntity({
      workflowRunId: 'run-1',
      workflowSlug: 'wf',
      workflowVersion: 7,
      agentSlug: 'soap-finalizer',
      agentVersion: 4,
      nodeId: 'finalize',
      model: 'gemma',
      provider: 'lm-studio',
      deployment: 'SELF_HOSTED',
      tokensIn: 10,
      tokensOut: 5,
      contextUsed: 15,
      contextWindow: 32768,
      outputCap: 6144,
      costMicros: 42n,
      costBasis: 'INTERNAL',
      durationMs: 900,
      endedAt: new Date('2026-10-05T10:00:01.000Z'),
      outputVersionNumber: 3,
    });

    const record = ActivityRunMapper.toActivityRunRecord(entity);
    expect(record).toMatchObject({
      id: entity.id,
      runId: 'run-1',
      workflowSlug: 'wf',
      workflowVersion: 7,
      agentSlug: 'soap-finalizer',
      agentVersion: 4,
      nodeId: 'finalize',
      activityKind: 'NOTE_GENERATE',
      model: 'gemma',
      provider: 'lm-studio',
      deployment: 'SELF_HOSTED',
      tokensIn: 10,
      tokensOut: 5,
      contextUsed: 15,
      contextWindow: 32768,
      outputCap: 6144,
      costMicros: 42,
      costBasis: 'INTERNAL',
      durationMs: 900,
      startedAt: '2026-10-05T10:00:00.000Z',
      endedAt: '2026-10-05T10:00:01.000Z',
      versionNumber: 3,
    });
    expect(ActivityRunMapper.toRunSummary(entity)).not.toHaveProperty('nodeId');
  });
});
