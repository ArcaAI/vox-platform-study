/**
 * TASK-946 D2 — `ensureTemplateResolved` freezes the shape of the branch the session TAKES.
 *
 * The unit-level rule is pinned in `realtime/__tests__/realtime-template-branch.task946.test.ts`;
 * this suite pins the WIRE-UP, which is where the 2026-09-10 defect actually lived: the slug was
 * read off the frozen lane with no routing decision at all, so a consultation carrying a
 * `parentConsultationId` froze `arcaai-bren-soap-new-visit` while its own `n_summary_revisit`
 * node ran on every flush.
 *
 * It also pins the ORDER that makes the fix possible: the visit type is frozen by the substrate
 * read (`ensureSubstrateResolved`), and the template freeze must happen after it — before this
 * ticket the template promise was kicked off FIRST, so `session.visitType` was still `undefined`
 * when the branch would have been evaluated.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const TENANT = 'tenant-946-template';
const CID = 'consultation-946-template';
const WORKFLOW_SLUG = 'arcaai-bren-consultation';
const NEW_VISIT_SLUG = 'arcaai-bren-soap-new-visit';
const REVISIT_SLUG = 'arcaai-bren-soap-revisit';

const REALTIME = { lane: 'realtime', cadence: 'perTurn' };

/** The seeded ArcaAI split, with the new-visit node FIRST — `seed/28-workflow-library.ts`. */
const SPLIT_CONFIG = {
  slug: WORKFLOW_SLUG,
  versionNumber: 3,
  stages: [
    {
      stageIndex: 0,
      nodes: [
        {
          nodeId: 'n_asr',
          type: 'core.agent',
          config: { agentRef: { task: 'SPEECH_TO_TEXT' }, execution: REALTIME },
          inputs: [],
          onError: 'fail',
        },
      ],
    },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'n_visit',
          type: 'core.condition',
          config: {
            branches: [
              { key: 'new_visit', when: "trigger.context.visit_type == 'new-visit'" },
              { key: 'revisit', when: "trigger.context.visit_type == 'revisit'" },
            ],
          },
          inputs: [],
          onError: 'degrade',
        },
      ],
    },
    {
      stageIndex: 2,
      nodes: [
        {
          nodeId: 'n_summary_new',
          type: 'core.agent',
          config: { agentRef: { task: 'TEXT_GENERATION' }, execution: REALTIME, documentTemplateSlug: NEW_VISIT_SLUG },
          inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }],
          onError: 'degrade',
          branchGuards: [
            { fromNodeId: 'n_visit', handle: 'new_visit' },
            { fromNodeId: 'n_visit', handle: 'else' },
          ],
        },
        {
          nodeId: 'n_summary_revisit',
          type: 'core.agent',
          config: { agentRef: { task: 'TEXT_GENERATION' }, execution: REALTIME, documentTemplateSlug: REVISIT_SLUG },
          inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }],
          onError: 'degrade',
          branchGuards: [{ fromNodeId: 'n_visit', handle: 'revisit' }],
        },
      ],
    },
  ],
};

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

function buildService(options: { isFollowUp: boolean }) {
  const post = vi.fn(async () => ({ data: {} }));
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const documentTemplateService = { resolveForGeneration: vi.fn(async () => PLATFORM_RESOLVED) };

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    undefined, // harnessPolicyService
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined, // routingPolicies
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    documentTemplateService as never,
    {
      findById: vi.fn(async (id: string) => ({
        id,
        tenantId: TENANT,
        metadata: null,
        departmentId: null,
        parentConsultationId: options.isFollowUp ? 'consultation-946-parent' : null,
      })),
    } as never,
    {
      resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: WORKFLOW_SLUG, source: 'tenant' })),
    } as never,
    { findPublishedBySlug: vi.fn(async () => ({ slug: WORKFLOW_SLUG, paletteKey: 'core', compiledConfig: SPLIT_CONFIG })) } as never,
  );

  return { service, documentTemplateService };
}

async function startAndSettle(service: LiveDocumentationService) {
  service.start({ consultationId: CID, tenantId: TENANT });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('TASK-946 D2 — the frozen note shape follows the consultation`s visit type', () => {
  it('a REVISIT (parentConsultationId set) freezes the revisit shape', async () => {
    const { service, documentTemplateService } = buildService({ isFollowUp: true });
    await startAndSettle(service);

    expect(
      documentTemplateService.resolveForGeneration,
      'the revisit froze the NEW-VISIT shape — the first template-bearing node in stage order, not the one the branch reaches',
    ).toHaveBeenCalledWith(TENANT, REVISIT_SLUG);

    await service.stop(CID, { persistSnapshot: false });
  });

  it('a NEW VISIT (no parent) freezes the new-visit shape', async () => {
    const { service, documentTemplateService } = buildService({ isFollowUp: false });
    await startAndSettle(service);

    expect(documentTemplateService.resolveForGeneration).toHaveBeenCalledWith(TENANT, NEW_VISIT_SLUG);

    await service.stop(CID, { persistSnapshot: false });
  });
});
