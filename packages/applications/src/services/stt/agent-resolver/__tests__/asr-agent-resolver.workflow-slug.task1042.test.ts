/**
 * TASK-1042 (C1) — `workflowSlug` on session create: the ASR agent resolves from that slug's
 * ACTIVE published version, from its single SPEECH_TO_TEXT `core.agent` node (TASK-1002's
 * "workflow wins"), and the session echoes `agentSource: 'workflow'`.
 *
 *  - an explicit `agentSlug` still wins (tier 1);
 *  - an unknown / invisible slug → 404;
 *  - more than one STT node → 409 `WORKFLOW_ASR_AGENT_UNAVAILABLE` (the existing code);
 *  - no STT node → the normal department / tenant resolution.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';
import { GoverningWorkflowAsrReader, WORKFLOW_ASR_AGENT_UNAVAILABLE } from '../governing-workflow-asr';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent } }>;
const asrAgent = fixture.platformDefault.input.agent;

const TENANT = '50000000-0000-0000-0000-000000000001';
const SLUG = 'dictate';

const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const consultations = { findById: vi.fn() };
const runs = { findById: vi.fn(), findByRunKey: vi.fn() };
const definitions = { findById: vi.fn(), findPublishedBySlug: vi.fn() };
const agentRows = { findPublishedActiveBySlug: vi.fn(), findPublishedVisibleBySlugVersion: vi.fn(), findAllVersionsBySlug: vi.fn() };

const TASK_BY_SLUG: Record<string, AgentTask> = {
  'dictation-asr': AgentTask.SPEECH_TO_TEXT,
  'second-asr': AgentTask.SPEECH_TO_TEXT,
  'soap-writer': AgentTask.TEXT_GENERATION,
};

const make = () =>
  new AsrAgentResolverService(agents as never, credentials as never, undefined, new GoverningWorkflowAsrReader(consultations as never, runs as never, definitions as never, agentRows as never));

const published = (agentNodes: Array<[string, string]>) => ({
  id: 'wf-v2',
  tenantId: TENANT,
  slug: SLUG,
  versionNumber: 2,
  compiledConfig: {
    stages: [
      { stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', config: {} }] },
      { stageIndex: 1, nodes: agentNodes.map(([nodeId, slug]) => ({ nodeId, type: 'core.agent', config: { agentRef: { slug } } })) },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
  agentRows.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => (TASK_BY_SLUG[slug] ? { slug, task: TASK_BY_SLUG[slug] } : null));
  agentRows.findPublishedVisibleBySlugVersion.mockResolvedValue(null);
  agentRows.findAllVersionsBySlug.mockResolvedValue([]);
});

describe('TASK-1042 C1 — the workflowSlug arm', () => {
  it('resolves the published workflow`s single STT node agent, fail-closed, with source `workflow`', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(published([['n_asr', 'dictation-asr'], ['n_note', 'soap-writer']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, slug: 'dictation-asr' });

    const session = await make().resolve({ tenantId: TENANT, workflowSlug: SLUG });

    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(TENANT, SLUG);
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'dictation-asr', departmentId: null, primaryBinding: 'fail-closed' });
    expect(session.spec.agent.source).toBe('workflow');
    expect(session.workflowDefinitionSlug).toBe(SLUG);
    expect(consultations.findById).not.toHaveBeenCalled();
  });

  it('an explicit agentSlug still wins: the workflow is not read', async () => {
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, source: 'explicit' });
    const session = await make().resolve({ tenantId: TENANT, workflowSlug: SLUG, agentSlug: 'platform-transcription' });
    expect(definitions.findPublishedBySlug).not.toHaveBeenCalled();
    expect(session.spec.agent.source).toBe('explicit');
  });

  it('an unknown or invisible slug is 404', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(null);
    await expect(make().resolve({ tenantId: TENANT, workflowSlug: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
    expect(agents.resolve).not.toHaveBeenCalled();
  });

  it('more than one STT node is 409 WORKFLOW_ASR_AGENT_UNAVAILABLE', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(published([['a', 'dictation-asr'], ['b', 'second-asr']]));
    const error = await make().resolve({ tenantId: TENANT, workflowSlug: SLUG }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: WORKFLOW_ASR_AGENT_UNAVAILABLE, reason: 'ambiguous' });
  });

  it('a named agent that will not resolve is 409 WORKFLOW_ASR_AGENT_UNAVAILABLE (unavailable)', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(published([['n_asr', 'dictation-asr']]));
    agents.resolve.mockRejectedValueOnce(new NotFoundException('agent gone'));
    const error = await make().resolve({ tenantId: TENANT, workflowSlug: SLUG }).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: WORKFLOW_ASR_AGENT_UNAVAILABLE, reason: 'unavailable' });
  });

  it('no STT node: the normal department / tenant resolution', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(published([['n_note', 'soap-writer']]));
    agents.resolve.mockResolvedValueOnce({ ...asrAgent, source: 'tenant' });
    const session = await make().resolve({ tenantId: TENANT, workflowSlug: SLUG, departmentId: 'dept-1' });
    expect(agents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: null, departmentId: 'dept-1', primaryBinding: 'mark' });
    expect(session.spec.agent.source).toBe('tenant');
    expect(session).not.toHaveProperty('workflowDefinitionSlug');
  });
});
