// MUST be first — `services/index.ts` participates in a PRE-EXISTING import cycle, so requiring a
// deep module file first can leave `imports` entries `undefined` at decoration time. Importing the
// package barrel reproduces the production evaluation order (as `text-enrichment.di-wiring.task808`).
import '../../../../index';
/**
 * TASK-1006 — the synchronous comprehensive summary runs on the AGENT PLANE.
 *
 * `POST consultations/:id/summary/comprehensive` used to assemble its own prompt from the prompt-
 * template tiers and POST it straight to TEXT's `/api/v1/generate`, borrowing only the model of the
 * tenant's assigned agent. Owner directive: everything runs on agents and workflows. The route keeps
 * its contract (and its one caller, the browser SDK's `generateComprehensiveSummary`), but the
 * generation is now an invocation of the tenant's published TEXT_GENERATION agent for the finalize
 * phase, through the same `AgentInvocationService` the business-plane `POST agents/:slug/invocations`
 * uses: the agent's instruction, parameters, credential and guardrail decision all apply.
 *
 * What stays the chain summary's own job is the INPUT: the linked consultations' sections (and NER)
 * become the invocation `text`, and the requesting consultation's clinical context is supplied as
 * `variables` under the consultation-note vocabulary the seeded agents bind.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChainSummaryService } from '../chain-summary.service';
import { ChainSummaryServiceModule } from '../chain-summary.service.module';
import { AgentInvocationService } from '../../../agent/agent-invocation.service';
import { AgentResolverService } from '../../../agent/agent-resolver.service';
import { resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1';
const AGENT = { slug: 'general-medicine-summarization', task: 'TEXT_GENERATION', agentVersionId: 'agent-v-1' };

function build(overrides: { invokeText?: ReturnType<typeof vi.fn>; resolve?: ReturnType<typeof vi.fn>; settings?: unknown } = {}) {
  const consultation = {
    id: 'c-1',
    tenantId: TENANT,
    patientId: 'pat-1',
    doctorId: 'doc-1',
    departmentId: 'dept-1',
    parentConsultationId: null,
    metadata: null,
    spokenLanguageMode: 'ml-en',
    Department: { name: 'Cardiology' },
    Doctor: { username: 'dr.a' },
  };
  const contextItemRepository = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findSummaries: vi.fn().mockResolvedValue([{ id: 's-1', content: 'Chest pain, resolved.', createdAt: new Date('2026-09-20T10:00:00Z') }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findSharedContext: vi.fn().mockResolvedValue([]),
    // The entity's fields are getters, so they are read off it rather than spread.
    create: vi.fn().mockImplementation((item: { id: string; consultationId: string; type: string; content?: string }) =>
      Promise.resolve({
        id: item.id,
        consultationId: item.consultationId,
        type: item.type,
        content: item.content,
        createdAt: new Date('2026-09-25T10:00:00Z'),
        updatedAt: new Date('2026-09-25T10:00:00Z'),
      }),
    ),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue(consultation),
    findConsultationChain: vi.fn().mockResolvedValue([consultation]),
    findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
  };
  const namedEntityRepository = {
    findByContextItem: vi.fn().mockResolvedValue([{ text: 'Aspirin 75mg', className: 'MEDICATION', confidence: 0.9 }]),
  };
  const summaryMetaRepository = {
    create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const agentResolver = { resolve: overrides.resolve ?? vi.fn().mockResolvedValue(AGENT) };
  const agentInvocation = {
    invokeText:
      overrides.invokeText ??
      vi.fn().mockResolvedValue({
        text: 'Comprehensive note.',
        provider: 'lm-studio',
        model: 'medgemma',
        usage: { promptTokens: 400, completionTokens: 60 },
        usageDetail: null,
        promptFragments: null,
      }),
  };

  const service = new ChainSummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    namedEntityRepository as never,
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'doc-1' } : null)),
      set: vi.fn(),
      run: vi.fn((cb: () => unknown) => cb()),
    } as never,
    agentResolver as never,
    agentInvocation as never,
    // `.env.test` sets SECRETS_PROVIDER=vault, under which the PHI guard is fail-closed and refuses
    // to persist without a secrets service.
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never,
    undefined, // usageLedger
    undefined, // unitOfWork
    undefined, // noteGenerationService
    undefined, // visitTypes
    undefined, // computeDevice
    overrides.settings as never, // effectiveSettings
  );

  return { service, agentResolver, agentInvocation, contextItemRepository, summaryMetaRepository };
}

type Invocation = [unknown, string, { text: string; variables: Record<string, string> }, string];

describe('ChainSummaryService — comprehensive summary on the agent plane (TASK-1006)', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it('resolves the tenant`s TEXT_GENERATION agent for the finalize phase at the consultation`s department', async () => {
    await harness.service.generateComprehensiveSummary('c-1', {});

    expect(harness.agentResolver.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: 'TEXT_GENERATION',
      departmentId: 'dept-1',
      selectorTags: ['phase:finalize'],
    });
  });

  it('invokes that agent in blocking mode with the chain as `text` and the note context as `variables`', async () => {
    await harness.service.generateComprehensiveSummary('c-1', {});

    const [agent, tenantId, input, mode] = harness.agentInvocation.invokeText.mock.calls[0] as Invocation;
    expect(agent).toBe(AGENT);
    expect(tenantId).toBe(TENANT);
    expect(mode).toBe('blocking');
    expect(input.text).toContain('Department: Cardiology');
    expect(input.text).toContain('Chest pain, resolved.');
    expect(input.text).toContain('MEDICATION: Aspirin 75mg');
    expect(input.variables).toMatchObject({
      current_department: 'Cardiology',
      visit_type: 'new-visit',
      safe_age: 'Unknown',
      formatted_vitals: 'Not available',
      chief_complaint: '',
      // The SOURCE language rides as `language`; the note's OUTPUT language is the platform
      // default, never the declared code-switch.
      language: 'ml-en',
      language_name: 'English',
    });
    // Every value is a string — the TEXT_GENERATION input schema's `variables` contract.
    expect(Object.values(input.variables).every((value) => typeof value === 'string')).toBe(true);
  });

  it('persists the agent`s text as the RAW_SUMMARY and reports the served model', async () => {
    const result = await harness.service.generateComprehensiveSummary('c-1', {});

    expect(result.content).toBe('Comprehensive note.');
    expect(result.structuredData).toMatchObject({ modelName: 'medgemma', inputTokens: 400, outputTokens: 60 });
    expect(result.sourceConsultationIds).toEqual(['c-1']);
    expect(harness.summaryMetaRepository.create).toHaveBeenCalled();
  });

  it('omits the NER block when includeNER is false', async () => {
    await harness.service.generateComprehensiveSummary('c-1', { includeNER: false });

    const [, , input] = harness.agentInvocation.invokeText.mock.calls[0] as Invocation;
    expect(input.text).not.toContain('Named Entities');
  });

  it('writes in the platform-default output language a platform admin sets', async () => {
    const settings = { resolveEffective: vi.fn().mockResolvedValue({ value: 'ml' }) };
    const { service, agentInvocation } = build({ settings });

    await service.generateComprehensiveSummary('c-1', {});

    const [, , input] = agentInvocation.invokeText.mock.calls[0] as Invocation;
    expect(input.variables.language_name).toBe('Malayalam');
  });

  it('lets an unassigned agent refuse with its own named 503 — never a guessed model', async () => {
    const refusal = new ServiceUnavailableException({ code: 'AGENT_NOT_ASSIGNED' });
    const { service, agentInvocation } = build({ resolve: vi.fn().mockRejectedValue(refusal) });

    await expect(service.generateComprehensiveSummary('c-1', {})).rejects.toBe(refusal);
    expect(agentInvocation.invokeText).not.toHaveBeenCalled();
  });

  it('passes an agent-plane refusal through unchanged (e.g. a prompt variable the agent needs)', async () => {
    const refusal = new BadRequestException({ code: 'PROMPT_VARIABLES_MISSING' });
    const { service } = build({ invokeText: vi.fn().mockRejectedValue(refusal) });

    await expect(service.generateComprehensiveSummary('c-1', {})).rejects.toBe(refusal);
  });

  it('maps a TEXT transport failure to the route`s existing 400', async () => {
    const { service } = build({ invokeText: vi.fn().mockRejectedValue(new Error('socket hang up')) });

    await expect(service.generateComprehensiveSummary('c-1', {})).rejects.toThrow('Failed to generate comprehensive summary from AI service');
  });
});

describe('ChainSummaryServiceModule — the agent plane is actually wired', () => {
  // Both are REQUIRED constructor dependencies, so an unwired module fails the gateway's boot rather
  // than degrading; this pins the import so that failure never ships.
  it('resolves AgentResolverService and AgentInvocationService', () => {
    const tokens = resolvableTokens(ChainSummaryServiceModule);
    expect(tokens.has(AgentResolverService)).toBe(true);
    expect(tokens.has(AgentInvocationService)).toBe(true);
  });
});
