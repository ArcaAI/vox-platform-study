/**
 * TASK-1002 — ASR agent resolution precedence for a consultation-bound session:
 *
 *   1. explicit `agentSlug`                                   → source `explicit`
 *   2. the consultation's governing workflow (PINNED version) names exactly one
 *      SPEECH_TO_TEXT agent on a `core.agent` node             → source `workflow`
 *   3. the assignment cascade, under the consultation's department, no selector tags
 *   4. nothing                                                → AGENT_NOT_ASSIGNED (unchanged)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';
import { GoverningWorkflowAsrReader, WORKFLOW_ASR_AGENT_UNAVAILABLE } from '../governing-workflow-asr';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent } }>;
const asrAgent = fixture.platformDefault.input.agent;

const TENANT = '50000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '50000000-0000-0000-0000-000000000099';
const CONSULTATION = 'consultation-1';
const RUN = 'run-1';
const DEPT = 'dept-radiology';

const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const consultations = { findById: vi.fn() };
const runs = { findById: vi.fn() };
const definitions = { findById: vi.fn(), findPublishedBySlug: vi.fn() };
const agentRows = { findPublishedActiveBySlug: vi.fn(), findPublishedVisibleBySlugVersion: vi.fn(), findAllVersionsBySlug: vi.fn() };

const TASK_BY_SLUG: Record<string, AgentTask> = {
  'saaras-test': AgentTask.SPEECH_TO_TEXT,
  'realtime-rado-asr': AgentTask.SPEECH_TO_TEXT,
  'newer-asr': AgentTask.SPEECH_TO_TEXT,
  'second-asr': AgentTask.SPEECH_TO_TEXT,
  'soap-writer': AgentTask.TEXT_GENERATION,
};

const make = () =>
  new AsrAgentResolverService(
    agents as never,
    credentials as never,
    undefined,
    new GoverningWorkflowAsrReader(consultations as never, runs as never, definitions as never, agentRows as never),
  );

/** A compiled graph: a trigger, the given `core.agent` nodes, and an output. */
const compiled = (slug: string, versionNumber: number, agentNodes: Array<[nodeId: string, agentSlug: string]>) => ({
  formatVersion: 1,
  slug,
  versionNumber,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', config: {} }] },
    { stageIndex: 1, nodes: agentNodes.map(([nodeId, agentSlug]) => ({ nodeId, type: 'core.agent', config: { agentRef: { slug: agentSlug } } })) },
    { stageIndex: 2, nodes: [{ nodeId: 'n_output', type: 'core.output', config: {} }] },
  ],
  gates: [],
});

const definitionRow = (id: string, slug: string, versionNumber: number, agentNodes: Array<[string, string]>) => ({
  id,
  tenantId: TENANT,
  slug,
  versionNumber,
  compiledConfig: compiled(slug, versionNumber, agentNodes),
});

const governed = (workflowDefinitionSlug: string) => ({
  governingEngine: { engine: 'tenant-workflow', workflowRunId: RUN, workflowDefinitionSlug },
});

const consultationRow = (metadata: unknown, tenantId = TENANT) => ({ id: CONSULTATION, tenantId, departmentId: DEPT, metadata });

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
  agentRows.findPublishedActiveBySlug.mockImplementation(async (_tenantId: string, slug: string) =>
    TASK_BY_SLUG[slug] ? { slug, task: TASK_BY_SLUG[slug] } : null,
  );
  agentRows.findPublishedVisibleBySlugVersion.mockResolvedValue(null);
  agentRows.findAllVersionsBySlug.mockResolvedValue([]);
  runs.findById.mockResolvedValue({ id: RUN, tenantId: TENANT, workflowVersionId: 'wf-v3' });
});

describe('TASK-1002 — tier 1: an explicit slug', () => {
  it('1 · beats a workflow ASR node — the consultation is not even read', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockResolvedValue(definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [['n_asr', 'saaras-test']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, source: 'explicit' });

    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription', consultationId: CONSULTATION });

    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: 'platform-transcription',
      departmentId: null,
      primaryBinding: 'mark',
    });
    expect(consultations.findById).not.toHaveBeenCalled();
    expect(session.spec.agent.source).toBe('explicit');
    expect(session).not.toHaveProperty('workflowDefinitionSlug');
  });
});

describe('TASK-1002 — tier 2: the governing workflow', () => {
  it('2 · the workflow’s SPEECH_TO_TEXT node wins over the assignment cascade (source workflow, slug surfaced)', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockResolvedValue(
      definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [
        ['n_asr', 'saaras-test'],
        ['n_summary', 'soap-writer'],
      ]),
    );
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, slug: 'saaras-test', source: 'explicit' });

    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });

    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(agents.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'saaras-test' }),
    );
    expect(session.spec.agent.source).toBe('workflow');
    expect(session.spec.agent.slug).toBe('saaras-test');
    expect(session.workflowDefinitionSlug).toBe('arcaai-gen-consultation');
  });

  it('3 · the ASR node is found by its agent’s TASK, not its node id (the radiology graph puts it on n_summary)', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('radiology_report_generation')));
    definitions.findById.mockResolvedValue(definitionRow('wf-v3', 'radiology_report_generation', 1, [['n_summary', 'realtime-rado-asr']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, slug: 'realtime-rado-asr', source: 'explicit' });

    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });

    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'realtime-rado-asr', task: AgentTask.SPEECH_TO_TEXT }));
    expect(session.spec.agent.source).toBe('workflow');
    expect(session.workflowDefinitionSlug).toBe('radiology_report_generation');
  });

  it('4 · reads the version the governing RUN pinned, even when a newer version is active', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockImplementation(async (id: string) =>
      id === 'wf-v3' ? definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [['n_asr', 'saaras-test']]) : null,
    );
    definitions.findPublishedBySlug.mockResolvedValue(definitionRow('wf-v4', 'arcaai-gen-consultation', 4, [['n_asr', 'newer-asr']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, slug: 'saaras-test', source: 'explicit' });

    await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });

    expect(runs.findById).toHaveBeenCalledWith(RUN);
    expect(definitions.findById).toHaveBeenCalledWith('wf-v3');
    expect(definitions.findPublishedBySlug).not.toHaveBeenCalled();
    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'saaras-test' }));
    expect(agents.resolve).not.toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'newer-asr' }));
  });

  it('5 · two SPEECH_TO_TEXT nodes → 409 WORKFLOW_ASR_AGENT_UNAVAILABLE, reason ambiguous — never a guess', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockResolvedValue(
      definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [
        ['n_asr', 'saaras-test'],
        ['n_asr_2', 'second-asr'],
      ]),
    );

    const thrown = await make()
      .resolve({ tenantId: TENANT, consultationId: CONSULTATION })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect((thrown as ConflictException).getResponse()).toEqual(
      expect.objectContaining({
        code: WORKFLOW_ASR_AGENT_UNAVAILABLE,
        reason: 'ambiguous',
        workflowDefinitionSlug: 'arcaai-gen-consultation',
        message: expect.any(String),
      }),
    );
    expect(WORKFLOW_ASR_AGENT_UNAVAILABLE).toBe('WORKFLOW_ASR_AGENT_UNAVAILABLE');
    expect(agents.resolve).not.toHaveBeenCalled();
  });

  it('6 · the one named ASR agent does not resolve (unpublished) → 409 WORKFLOW_ASR_AGENT_UNAVAILABLE, reason unavailable — no cascade fall-through', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockResolvedValue(definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [['n_asr', 'drafted-asr']]));
    // Not published any more — its task is still known from the lineage's own rows.
    agentRows.findAllVersionsBySlug.mockResolvedValue([{ slug: 'drafted-asr', task: AgentTask.SPEECH_TO_TEXT }]);
    agents.resolve.mockRejectedValueOnce(new NotFoundException('Agent not found'));

    const thrown = await make()
      .resolve({ tenantId: TENANT, consultationId: CONSULTATION })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'WORKFLOW_ASR_AGENT_UNAVAILABLE',
        reason: 'unavailable',
        workflowDefinitionSlug: 'arcaai-gen-consultation',
        agentSlug: 'drafted-asr',
      }),
    );
    expect(agents.resolve).toHaveBeenCalledTimes(1);
  });

  it('6b · a named ASR agent whose connection can no longer serve → the same named 409, reason unavailable', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation')));
    definitions.findById.mockResolvedValue(definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [['n_asr', 'saaras-test']]));
    agents.resolve.mockRejectedValueOnce(new ConflictException({ code: 'AGENT_CONNECTION_UNAVAILABLE', message: 'disabled' }));

    const thrown = await make()
      .resolve({ tenantId: TENANT, consultationId: CONSULTATION })
      .catch((error: unknown) => error);

    expect((thrown as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ code: 'WORKFLOW_ASR_AGENT_UNAVAILABLE', reason: 'unavailable', agentSlug: 'saaras-test' }),
    );
    // Fail-closed on the named binding: the owner's OD-1 names "a connection disabled later".
    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'saaras-test', primaryBinding: 'fail-closed' }));
  });
});

describe('TASK-1002 — tier 3: the assignment cascade under the consultation’s department', () => {
  it('7 · a governing workflow with no SPEECH_TO_TEXT node → cascade with the consultation’s departmentId and NO selector tags', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('text-only')));
    definitions.findById.mockResolvedValue(definitionRow('wf-v3', 'text-only', 1, [['n_summary', 'soap-writer']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, source: 'department' });

    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });

    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: null,
      departmentId: DEPT,
      primaryBinding: 'mark',
    });
    expect(agents.resolve.mock.calls[0][0]).not.toHaveProperty('selectorTags');
    expect(session.spec.agent.source).toBe('department');
    expect(session).not.toHaveProperty('workflowDefinitionSlug');
  });

  it('8 · no workflow marker at all → no workflow opinion → cascade under the consultation’s department', async () => {
    consultations.findById.mockResolvedValue(consultationRow({ someClientKey: 'kept' }));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, source: 'tenant' });

    await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION, departmentId: 'ignored-input-dept' });

    expect(runs.findById).not.toHaveBeenCalled();
    expect(definitions.findById).not.toHaveBeenCalled();
    expect(definitions.findPublishedBySlug).not.toHaveBeenCalled();
    expect(agents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: null,
      departmentId: DEPT,
      primaryBinding: 'mark',
    });
  });

  it('8b · no governing run, but a workflowSelection marker → the selected slug’s published version is read', async () => {
    consultations.findById.mockResolvedValue(consultationRow({ workflowSelection: { workflowDefinitionSlug: 'arcaai-gen-consultation' } }));
    definitions.findPublishedBySlug.mockResolvedValue(definitionRow('wf-v3', 'arcaai-gen-consultation', 3, [['n_asr', 'saaras-test']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, slug: 'saaras-test', source: 'explicit' });

    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });

    expect(runs.findById).not.toHaveBeenCalled();
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(TENANT, 'arcaai-gen-consultation');
    expect(session.spec.agent.source).toBe('workflow');
    expect(session.workflowDefinitionSlug).toBe('arcaai-gen-consultation');
  });
});

describe('TASK-1002 — the consultation is tenant-scoped (404-over-403)', () => {
  it('9 · an unknown consultationId → 404, never a fall-through to the cascade', async () => {
    consultations.findById.mockRejectedValue(new DataNotFoundException('consultation', CONSULTATION));

    const thrown = await make()
      .resolve({ tenantId: TENANT, consultationId: CONSULTATION })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe('Consultation not found');
    expect(agents.resolve).not.toHaveBeenCalled();
  });

  it('9b · another tenant’s consultationId → the same 404', async () => {
    consultations.findById.mockResolvedValue(consultationRow(governed('arcaai-gen-consultation'), OTHER_TENANT));

    const thrown = await make()
      .resolve({ tenantId: TENANT, consultationId: CONSULTATION })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe('Consultation not found');
    expect(runs.findById).not.toHaveBeenCalled();
    expect(agents.resolve).not.toHaveBeenCalled();
  });
});

describe('TASK-1002 — without a consultationId nothing changes', () => {
  it('10 · the cascade call is byte-identical to today and no consultation is read', async () => {
    agents.resolve.mockResolvedValueOnce(asrAgent);

    const session = await make().resolve({ tenantId: TENANT, departmentId: 'dept-1' });

    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(agents.resolve.mock.calls[0][0]).toStrictEqual({
      tenantId: TENANT,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: null,
      departmentId: 'dept-1',
      primaryBinding: 'mark',
    });
    expect(consultations.findById).not.toHaveBeenCalled();
    expect(session).not.toHaveProperty('workflowDefinitionSlug');
  });
});
