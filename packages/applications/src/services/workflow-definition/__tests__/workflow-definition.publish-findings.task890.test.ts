/**
 * TASK-890 §3.5 (F-10, BLOCKER 1c) — the publish gate, WIRED.
 *
 * `workflowPublishProblems` was a complete, tested gate with ZERO callers: nothing in the gateway
 * invoked it, so a graph could be published with a `core.agent` node naming no agent, an
 * unparseable CEL branch, or a node config that its own schema rejects — and the failure surfaced
 * at run time, in a consultation. This suite pins the wiring, not the checks (those are
 * `packages/workflow-contract/src/__tests__/publish-findings.test.ts`):
 *
 * - `publish()` REFUSES on an ERROR finding, with the findings in the 400 body, and writes
 *   nothing — the gate runs before compile and before any entity mutation, exactly like the
 *   capability gate beside it.
 * - `validate()` RECORDS the same findings without refusing, so a draft gets the feedback long
 *   before anyone tries to publish it.
 * - A WARNING never blocks. `PROMPT_VARIABLE_UNDECLARED` is a WARNING in release 1 (the OD-C
 *   ramp) and `GUARDRAIL_OPTED_OUT` is a WARNING permanently — an opt-out is a decision to
 *   record, not a defect to refuse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

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

/**
 * A `core` graph whose PORTS all type-check — it is the node CONFIG that is wrong (`core.agent`
 * names no agent). The distinction matters: a port error is caught by the shape/port half of the
 * gate, and this suite is about the config half nothing ran before.
 */
const coreGraph = (triggerConfig: Record<string, unknown>, agentConfig: Record<string, unknown>) => ({
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'], ...triggerConfig }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: agentConfig, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
});

const AGENT_REF_MISSING_GRAPH = coreGraph({}, {});

/** The same graph with a real agent reference, and the workflow guardrail switch OFF. */
const OPTED_OUT_GRAPH = coreGraph({ guardrail: { enabled: false } }, { agentRef: { slug: 'summarizer' } });

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'agent_note',
  name: 'Agent Note',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: AGENT_REF_MISSING_GRAPH,
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
  createdAt: new Date('2026-09-06T00:00:00Z'),
  updatedAt: new Date('2026-09-06T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: true,
  changes: {},
  ...overrides,
});

function makeService(agentService?: {
  publishAgentViews: (slugs: readonly string[]) => Promise<Record<string, unknown>>;
}): WorkflowDefinitionService {
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
    undefined, // agentRepository
    undefined, // aiModelRepository
    undefined, // documentTemplateRepository
    undefined, // mcpServerRepository
    undefined, // agentPromotionService
    undefined, // evalPromotionGate
    undefined, // policyEngine
    agentService as never,
  );
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

describe('publish() refuses on a blocking publish finding', () => {
  beforeEach(() => mockRepository.findById.mockResolvedValue(entity()));

  it('throws a 400 carrying the findings, and writes NOTHING', async () => {
    const error = await makeService()
      .publish('def-1', {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      findings: Array<{ code: string; nodeId: string; severity: string }>;
    };
    expect(response.findings.some((f) => f.code === 'AGENT_REF_MISSING' && f.nodeId === 'a1' && f.severity === 'ERROR')).toBe(true);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});

describe('validate() records the same findings WITHOUT refusing', () => {
  it('lands them on `validationReport.findings` and keeps the row a DRAFT', async () => {
    mockRepository.findById.mockResolvedValue(entity());
    const validated = await makeService().validate('def-1');
    const report = validated.validationReport as unknown as { ok: boolean; findings: Array<{ code?: string }> };
    expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    expect(report.ok).toBe(false);
    expect(validated.status).toBe(WorkflowDefinitionStatus.DRAFT);
  });
});

describe('a WARNING finding never blocks', () => {
  it('publishes a graph whose workflow guardrail switch is OFF, and records GUARDRAIL_OPTED_OUT', async () => {
    mockRepository.findById.mockResolvedValue(entity({ graph: OPTED_OUT_GRAPH }));
    const published = await makeService().publish('def-1', { activate: false });
    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    const written = mockRepository.update.mock.calls[0]?.[1] as { validationReport: { findings: Array<{ code?: string; severity: string }> } };
    const optOut = written.validationReport.findings.filter((f) => f.code === 'GUARDRAIL_OPTED_OUT');
    expect(optOut.length).toBeGreaterThan(0);
    expect(optOut.every((f) => f.severity === 'WARNING')).toBe(true);
  });
});

/**
 * TASK-890 §3.5 (L8 → the wave-2b close) — the `agents` slot of `PublishContext`, WIRED.
 *
 * L8 exposed `AgentService.publishAgentViews(slugs)` — the per-agent facts the gate checks a
 * `core.agent` node's prompt references and generation overrides against — but nothing at the
 * graph call site resolved it, so the gate silently skipped those checks on every workflow
 * publish. It is the same failure mode the gate itself was written to end: a complete check with
 * no caller.
 */
describe('the graph publish gate resolves the referenced agents', () => {
  const PROMPT_GRAPH = coreGraph({}, { agentRef: { slug: 'summarizer' } });

  beforeEach(() => mockRepository.findById.mockResolvedValue(entity({ graph: PROMPT_GRAPH })));

  it('asks the agent service for exactly the slugs the graph names', async () => {
    const publishAgentViews = vi.fn(async () => ({}));
    await makeService({ publishAgentViews }).publish('def-1', { activate: false });

    expect(publishAgentViews).toHaveBeenCalledWith(['summarizer']);
  });

  it('WARNS on a `core.agent` override referencing a variable the agent does not declare', async () => {
    const graph = coreGraph({}, { agentRef: { slug: 'summarizer' }, overrides: { promptVariables: { tone: '{{context.absent}}' } } });
    mockRepository.findById.mockResolvedValue(entity({ graph }));
    // The agent's BOUND context schema is what makes `context.absent` undeclared rather than
    // merely unknown: an unresolved slot admits any sub-path, which is why wiring the slot is
    // the whole of this fix.
    const publishAgentViews = vi.fn(async () => ({
      summarizer: {
        declaredVariables: ['tone'],
        contextPayloadSchema: { type: 'object', additionalProperties: false, properties: { language: { type: 'string' } } },
      },
    }));

    const published = await makeService({ publishAgentViews }).publish('def-1', { activate: false });

    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    const written = mockRepository.update.mock.calls[0]?.[1] as { validationReport: { findings: Array<{ code?: string; severity: string }> } };
    const undeclared = written.validationReport.findings.filter((f) => f.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(undeclared.length).toBeGreaterThan(0);
    expect(undeclared.every((f) => f.severity === 'WARNING')).toBe(true);
  });

  it('says nothing when the agent DOES declare it', async () => {
    const graph = coreGraph({}, { agentRef: { slug: 'summarizer' }, overrides: { promptVariables: { tone: '{{context.language}}' } } });
    mockRepository.findById.mockResolvedValue(entity({ graph }));
    const publishAgentViews = vi.fn(async () => ({
      summarizer: {
        declaredVariables: ['tone'],
        contextPayloadSchema: { type: 'object', additionalProperties: false, properties: { language: { type: 'string' } } },
      },
    }));

    await makeService({ publishAgentViews }).publish('def-1', { activate: false });

    const written = mockRepository.update.mock.calls[0]?.[1] as { validationReport: { findings: Array<{ code?: string }> } };
    expect(written.validationReport.findings.some((f) => f.code === 'PROMPT_VARIABLE_UNDECLARED')).toBe(false);
  });

  // Best-effort by contract: the publish-gate checks this slot feeds are the ones that stop
  // running, never the publish itself. A refusal caused by the gate's own dependency would be a
  // worse failure than the one it prevents.
  it('degrades to "not checked" when the resolution throws, and still publishes', async () => {
    const publishAgentViews = vi.fn(async () => {
      throw new Error('agent plane unavailable');
    });

    const published = await makeService({ publishAgentViews }).publish('def-1', { activate: false });

    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });
});
