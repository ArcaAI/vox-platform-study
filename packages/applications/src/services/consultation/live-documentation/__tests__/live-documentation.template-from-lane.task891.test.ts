/**
 * TASK-891 D7 — the note's SHAPE comes from the governing workflow, not from the tenant default.
 *
 * ## The defect
 *
 * `ensureTemplateResolved` called `resolveForGeneration(session.tenantId)` and passed no
 * slug — even though `DocumentTemplateService.resolveForGeneration(tenantId, slug?)` has
 * accepted one since it was written and NOTHING in the repository passed it. The traced
 * 2026-09-07 session logged:
 *
 * ```
 * Froze the live document template — templateId: null, slug "soap_note", versionNumber: null
 * Froze the realtime lane — laneSource "tenant-graph", definitionSlug "arcaai-consultation-medical-ner"
 * ```
 *
 * i.e. it fell through to `PLATFORM_TEMPLATE` while the governing workflow was frozen on the
 * same session, one field away.
 *
 * Per OD-2 the fix needs no new table: the workflow's `consultation.realtimeSummary` node
 * config is already `Readonly<Record<string, unknown>>`, so it carries `documentTemplateSlug`
 * and `ensureTemplateResolved` passes it into the parameter that already exists. Department
 * and visit-type selection happen one layer up, on the WorkflowAssignment cascade.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { realtimeDocumentTemplateSlug } from '../realtime/realtime-lane';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { RealtimeLane } from '../realtime';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-891-d7';
const WORKFLOW_SLUG = 'arcaai-consultation-medical-ner';
const TEMPLATE_SLUG = 'ward_round_note';

/** A tenant graph whose realtime summary node names the note shape (OD-2 wire-up 3). */
const configWithTemplate = (templateSlug?: string) => ({
  slug: WORKFLOW_SLUG,
  versionNumber: 3,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'summarize',
          type: 'consultation.realtimeSummary',
          config: templateSlug ? { documentTemplateSlug: templateSlug } : {},
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
});

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-07T00:00:00.000Z',
});

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

const PLATFORM_RESOLVED = {
  templateId: null,
  slug: 'soap_note',
  versionNumber: null,
  documentTemplateVersionId: null,
  compiled: {
    compilerVersion: '1',
    title: 'SOAP note',
    sectionKeys: ['subjective'],
    responseFormat: undefined,
    checklist: [{ key: 'subjective', title: 'Subjective', form: 'PROSE', required: true }],
    sectionStates: { sections: [], transitions: [] },
    promptInstruction: '',
  },
};

function buildService(templateSlug?: string) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) return { data: { summary: 'Subjective: cough' } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const documentTemplateService = { resolveForGeneration: vi.fn(async () => PLATFORM_RESOLVED) };

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    documentTemplateService as never,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    {
      resolve: vi.fn(
        async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: WORKFLOW_SLUG, source: 'tenant' }),
      ),
    } as never,
    {
      findPublishedBySlug: vi.fn(async () => ({
        slug: WORKFLOW_SLUG,
        paletteKey: 'consultation',
        compiledConfig: configWithTemplate(templateSlug),
      })),
    } as never,
  );

  return { service, documentTemplateService };
}

async function startAndSettle(service: LiveDocumentationService) {
  service.start({ consultationId: CID, tenantId: TENANT });
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('TASK-891 D7 — realtimeDocumentTemplateSlug', () => {
  it('reads the slug off the realtime summary node', () => {
    const lane: RealtimeLane = {
      source: 'tenant-graph',
      definitionSlug: WORKFLOW_SLUG,
      definitionVersionNumber: 3,
      guardrail: null,
      stages: [
        {
          stageIndex: 0,
          nodes: [
            {
              nodeId: 'summarize',
              type: 'consultation.realtimeSummary',
              config: { documentTemplateSlug: TEMPLATE_SLUG },
              timeoutMs: 1000,
              maxAttempts: 1,
              inputs: [],
              onError: 'degrade',
              enabled: true,
            },
          ],
        },
      ],
    };
    expect(realtimeDocumentTemplateSlug(lane)).toBe(TEMPLATE_SLUG);
  });

  it('is null when the lane names none, when there is no lane, and for a blank value', () => {
    expect(realtimeDocumentTemplateSlug(null)).toBeNull();
    const lane: RealtimeLane = {
      source: 'tenant-graph',
      definitionSlug: WORKFLOW_SLUG,
      definitionVersionNumber: 3,
      guardrail: null,
      stages: [
        {
          stageIndex: 0,
          nodes: [
            {
              nodeId: 'summarize',
              type: 'consultation.realtimeSummary',
              config: { documentTemplateSlug: '   ' },
              timeoutMs: 1000,
              maxAttempts: 1,
              inputs: [],
              onError: 'degrade',
              enabled: true,
            },
          ],
        },
      ],
    };
    expect(realtimeDocumentTemplateSlug(lane)).toBeNull();
  });
});

describe('TASK-891 D7 — ensureTemplateResolved passes the workflow`s slug', () => {
  it('resolves the template the governing workflow names', async () => {
    const { service, documentTemplateService } = buildService(TEMPLATE_SLUG);
    await startAndSettle(service);

    expect(
      documentTemplateService.resolveForGeneration,
      'the template was resolved on tenant id alone — the governing workflow named a shape and nothing read it',
    ).toHaveBeenCalledWith(TENANT, TEMPLATE_SLUG);

    await service.stop(CID, { persistSnapshot: false });
  });

  it('falls back to the tenant default when the workflow names no template (behaviour before D7)', async () => {
    const { service, documentTemplateService } = buildService(undefined);
    await startAndSettle(service);

    expect(documentTemplateService.resolveForGeneration).toHaveBeenCalledWith(TENANT, undefined);

    await service.stop(CID, { persistSnapshot: false });
  });
});
