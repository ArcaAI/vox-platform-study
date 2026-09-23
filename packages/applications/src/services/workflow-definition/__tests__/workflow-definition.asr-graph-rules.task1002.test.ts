/**
 * TASK-1002 (OD-2, OD-5) — two graph rules the publish gate enforces, both ERROR.
 *
 * Rule A (OD-2): a graph may carry at most ONE `core.agent` node whose agent transcribes
 * (task `SPEECH_TO_TEXT`). Identified by the agent's TASK, never by node id.
 *
 * Rule B (OD-5): a `core.output` whose `outputSchema.required` keys cannot be produced by the
 * node(s) feeding it is refused. A speech-to-text node produces a fixed shape; any other agent
 * produces what its declared `outputSchema.properties` says; an unknown shape is never flagged.
 *
 * The radiology fixture is the real tenant graph (`radiology_report_generation` v1) whose first
 * run failed at its first output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const MULTIPLE_ASR = 'MULTIPLE_SPEECH_TO_TEXT_AGENTS';
const UNREACHABLE = 'OUTPUT_FIELDS_UNREACHABLE';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

type AgentRow = { slug: string; versionNumber: number; task: string; outputSchema: unknown; compiledConfig: null };
const AGENTS: Record<string, AgentRow> = {
  'realtime-rado-asr': { slug: 'realtime-rado-asr', versionNumber: 1, task: 'SPEECH_TO_TEXT', outputSchema: null, compiledConfig: null },
  'second-asr': { slug: 'second-asr', versionNumber: 1, task: 'SPEECH_TO_TEXT', outputSchema: null, compiledConfig: null },
  'rado-summary': {
    slug: 'rado-summary',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    outputSchema: { type: 'object', required: ['case_note'], properties: { case_note: { type: 'string' } } },
    compiledConfig: null,
  },
  'schemaless-writer': { slug: 'schemaless-writer', versionNumber: 1, task: 'TEXT_GENERATION', outputSchema: null, compiledConfig: null },
};
const mockAgentRepository = {
  findPublishedActiveBySlug: vi.fn(async (_tenantId: string, slug: string) => AGENTS[slug] ?? null),
  findPublishedVisibleBySlugVersion: vi.fn(async (_tenantId: string, slug: string) => AGENTS[slug] ?? null),
};

const node = (id: string, type: string, config: Record<string, unknown>, x: number) => ({ id, type, config, position: { x, y: 0 } });
const edge = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({ id, from, fromPort, to, toPort });

const CASE_NOTE_OUTPUT = {
  outputSchema: {
    type: 'object',
    required: ['case_note'],
    properties: { case_note: { type: 'string' }, redactions: { type: 'array', items: { type: 'object' } } },
  },
  onSchemaViolation: 'fail',
};

/** `radiology_report_generation` v1, as the tenant published it. */
const RADIOLOGY_GRAPH = {
  version: 1,
  nodes: [
    node('n_trigger', 'core.trigger', { kinds: ['api'] }, 0),
    node('n_summary', 'core.agent', { agentRef: { slug: 'realtime-rado-asr' }, execution: { lane: 'realtime' } }, 1),
    node('n_output', 'core.output', CASE_NOTE_OUTPUT, 2),
  ],
  edges: [edge('e1', 'n_trigger', 'out', 'n_summary', 'context'), edge('e2', 'n_summary', 'out', 'n_output', 'in')],
};

const TWO_ASR_GRAPH = {
  version: 1,
  nodes: [
    node('n_trigger', 'core.trigger', { kinds: ['api'] }, 0),
    node('n_asr_a', 'core.agent', { agentRef: { slug: 'realtime-rado-asr' } }, 1),
    node('n_asr_b', 'core.agent', { agentRef: { slug: 'second-asr' } }, 1),
    node('n_output', 'core.output', { protocols: ['http'] }, 2),
  ],
  edges: [
    edge('e1', 'n_trigger', 'out', 'n_asr_a', 'context'),
    edge('e2', 'n_trigger', 'out', 'n_asr_b', 'context'),
    edge('e3', 'n_asr_a', 'out', 'n_output', 'in'),
  ],
};

/** ASR → a text agent that writes `case_note` → output: the rebuilt radiology graph. */
const chainGraph = (writerSlug: string) => ({
  version: 1,
  nodes: [
    node('n_trigger', 'core.trigger', { kinds: ['api'] }, 0),
    node('n_asr', 'core.agent', { agentRef: { slug: 'realtime-rado-asr' } }, 1),
    node('n_summary', 'core.agent', { agentRef: { slug: writerSlug } }, 2),
    node('n_output', 'core.output', CASE_NOTE_OUTPUT, 3),
  ],
  edges: [
    edge('e1', 'n_trigger', 'out', 'n_asr', 'context'),
    edge('e2', 'n_asr', 'out', 'n_summary', 'in'),
    edge('e3', 'n_summary', 'out', 'n_output', 'in'),
  ],
});

const entity = (graph: unknown) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'radiology_report_generation',
  name: 'Radiology report',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-23T00:00:00Z'),
  updatedAt: new Date('2026-09-23T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: true,
  changes: {},
});

function makeService(): WorkflowDefinitionService {
  return new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined, // entitlements
    undefined, // sttPipelineCompiler
    undefined, // workflowValidator
    undefined, // promptTemplateRepository
    undefined, // promptVersionRepository
    undefined, // contextSchemaService
    undefined, // routingPolicyService
    mockAgentRepository as never, // agentRepository
  );
}

type Finding = { code?: string; nodeId: string | null; severity: string; message: string };

async function findingsOf(graph: unknown): Promise<Finding[]> {
  mockRepository.findById.mockResolvedValue(entity(graph));
  const validated = await makeService().validate('def-1');
  return (validated.validationReport as unknown as { findings: Finding[] }).findings;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    return undefined;
  });
  mockRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.findPublishedBySlug.mockResolvedValue(null);
});

describe('rule A — at most one speech-to-text agent node', () => {
  it('reports an ERROR naming both nodes and both agents when two nodes transcribe', async () => {
    const findings = await findingsOf(TWO_ASR_GRAPH);
    const hits = findings.filter((f) => f.code === MULTIPLE_ASR);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('ERROR');
    for (const fragment of ['n_asr_a', 'n_asr_b', 'realtime-rado-asr', 'second-asr']) {
      expect(hits[0]!.message).toContain(fragment);
    }
  });

  it('says nothing about a graph with exactly one speech-to-text agent node', async () => {
    const findings = await findingsOf(chainGraph('rado-summary'));
    expect(findings.filter((f) => f.code === MULTIPLE_ASR)).toEqual([]);
  });
});

describe('rule B — an output must be fed the fields it requires', () => {
  it('refuses the radiology graph: `case_note` cannot come from a speech-to-text agent', async () => {
    const findings = await findingsOf(RADIOLOGY_GRAPH);
    const hits = findings.filter((f) => f.code === UNREACHABLE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('ERROR');
    expect(hits[0]!.nodeId).toBe('n_output');
    expect(hits[0]!.message).toBe(
      'Output `n_output` requires `case_note`, but its input comes from `n_summary`, a speech-to-text agent (`realtime-rado-asr`) ' +
        'that produces only transcript, segments, audio. Add an agent that writes `case_note` ' +
        '(for example a text-generation summary agent) between them.',
    );
  });

  it('accepts ASR → a text agent whose output schema declares `case_note` → output', async () => {
    const findings = await findingsOf(chainGraph('rado-summary'));
    expect(findings.filter((f) => f.code === UNREACHABLE)).toEqual([]);
  });

  it('does not flag an output fed by an agent that declares no output schema (shape unknown)', async () => {
    const findings = await findingsOf(chainGraph('schemaless-writer'));
    expect(findings.filter((f) => f.code === UNREACHABLE)).toEqual([]);
  });

  it('flags an agent whose declared output schema lacks the required field', async () => {
    const graph = chainGraph('rado-summary');
    const narrowWriter = {
      ...AGENTS['rado-summary']!,
      slug: 'narrow-writer',
      outputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    };
    mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) =>
      slug === 'narrow-writer' ? narrowWriter : (AGENTS[slug] ?? null),
    );
    (graph.nodes[2]!.config as { agentRef: { slug: string } }).agentRef.slug = 'narrow-writer';
    const hits = (await findingsOf(graph)).filter((f) => f.code === UNREACHABLE);
    mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_t: string, slug: string) => AGENTS[slug] ?? null);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('`narrow-writer`');
    expect(hits[0]!.message).toContain('note');
  });
});

describe('publish() refuses a graph failing either rule, and writes nothing', () => {
  it.each([
    ['rule A', TWO_ASR_GRAPH, MULTIPLE_ASR],
    ['rule B', RADIOLOGY_GRAPH, UNREACHABLE],
  ])('%s', async (_label, graph, code) => {
    mockRepository.findById.mockResolvedValue(entity(graph));
    const error = await makeService()
      .publish('def-1', {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as { findings: Finding[] };
    expect(response.findings.some((f) => f.code === code && f.severity === 'ERROR')).toBe(true);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});
