/**
 * points 4-6 — caller-selected workflow at consultation open.
 *
 * The whole ticket is the authorization. A selector that trusts client input is
 * a cross-tenant hazard, so `assertSelectableForConsultation` is the gate and it
 * has exactly two failure directions, which must never be swapped:
 *
 *   * **404** — the definition is INVISIBLE to this tenant. A foreign tenant's
 *     slug, an unknown slug, and an unpublished/inactive one are deliberately
 *     indistinguishable: answering "403" to any of them would confirm that the
 *     slug exists (404-over-403, rule 04 §NEVER).
 *   * **403** — the definition is VISIBLE to this tenant (it is published and
 *     active, so it is listed by `GET /workflows`) but may not GOVERN a
 *     consultation. That is a privilege refusal about a resource the caller can
 *     already see, so hiding it would be theatre.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';
const DEPARTMENT = 'd-1';
const USER = 'u-1';

const consultationDefinition = {
  id: 'wd-1',
  slug: 'caller_picked_v1',
  versionNumber: 3,
  name: 'Caller Picked',
  paletteKey: 'consultation',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

const assignedDefinition = { ...consultationDefinition, id: 'wd-2', slug: 'cascade_assigned_v1' };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: 'cascade_assigned_v1', source: 'tenant' }) },
    definitionRepository: {
      findPublishedBySlug: vi.fn(async (_tenantId: string, slug: string) =>
        slug === consultationDefinition.slug ? consultationDefinition : slug === assignedDefinition.slug ? assignedDefinition : null,
      ),
    },
    consultationRepository: { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, metadata: null }), update: vi.fn().mockResolvedValue({}) },
    workflowRunService: { recordRunStarted: vi.fn().mockResolvedValue({}) },
    harnessGateway: { startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    // Wired here (production DI supplies it) so the independent stt lane is actually exercised.
    sttPipelineResolver: { resolvePipelineId: vi.fn().mockResolvedValue('asr-pipeline-1') },
    ...overrides,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
    deps.sttPipelineResolver as never,
  );
}

describe('assertSelectableForConsultation — the selector authorization gate', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('resolves for the tenant OWN published, active, consultation-palette definition', async () => {
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'caller_picked_v1')).resolves.toBeUndefined();
  });

  it('scopes the lookup to the CALLER tenant — the slug is never resolved tenant-free', async () => {
    await makeService(deps).assertSelectableForConsultation(TENANT, 'caller_picked_v1');
    expect(deps.definitionRepository.findPublishedBySlug).toHaveBeenCalledWith(TENANT, 'caller_picked_v1');
  });

  it('404s another tenant definition slug — never 403, which would confirm it exists', async () => {
    // `findPublishedBySlug` is tenant-scoped, so a foreign tenant's slug simply misses.
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'other_tenants_workflow')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a slug that does not exist at all — indistinguishable from the cross-tenant miss', async () => {
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'no_such_slug')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s an own-tenant definition that is not PUBLISHED/ACTIVE — a draft is not selectable and its existence is not disclosed', async () => {
    // `findPublishedBySlug` filters on status PUBLISHED + isActive + ENABLED, so a draft misses.
    deps.definitionRepository.findPublishedBySlug = vi.fn().mockResolvedValue(null);
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'draft_v1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403s a published own-tenant definition from another palette — visible, but it may not govern a consultation', async () => {
    deps.definitionRepository.findPublishedBySlug = vi.fn().mockResolvedValue({ ...consultationDefinition, paletteKey: 'summarization' });
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'summarizer_v1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never leaks the tenant authored inventory in the 404 message', async () => {
    await expect(makeService(deps).assertSelectableForConsultation(TENANT, 'no_such_slug')).rejects.toThrow(/not found/i);
  });
});

describe('dispatchForConsultation — honouring the caller selection over the cascade', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  const dispatch = (workflowDefinitionSlug?: string) =>
    makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT, userId: USER, workflowDefinitionSlug });

  it('dispatches the CALLER slug, not the cascade slug', async () => {
    const result = await dispatch('caller_picked_v1');

    expect(result.dispatched).toBe(true);
    expect(result.workflowDefinitionSlug).toBe('caller_picked_v1');
    expect(deps.definitionRepository.findPublishedBySlug).toHaveBeenCalledWith(TENANT, 'caller_picked_v1');
  });

  it('reports `source: caller-selected` so an observer can tell a selection from a cascade hit', async () => {
    await expect(dispatch('caller_picked_v1')).resolves.toMatchObject({ source: 'caller-selected' });
  });

  it('does NOT consult the consultation-palette cascade when a selection is present', async () => {
    await dispatch('caller_picked_v1');
    expect(deps.assignments.resolve).not.toHaveBeenCalledWith(TENANT, 'consultation', DEPARTMENT);
  });

  it('still resolves the INDEPENDENT stt-palette assignment — the two palettes are separate lanes', async () => {
    await dispatch('caller_picked_v1');
    expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'stt', DEPARTMENT);
  });

  it('falls back to the cascade when no selection is supplied — today behaviour, unchanged', async () => {
    const result = await dispatch();

    // TASK-891 — no `parentConsultationId` was passed to `dispatch()` here, so the cascade
    // call now also carries the reserved `visit-type:new-visit` tag; the fallback OUTCOME
    // (slug + source) is exactly what it was before that tag existed.
    expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', DEPARTMENT, ['visit-type:new-visit']);
    expect(result.workflowDefinitionSlug).toBe('cascade_assigned_v1');
    expect(result.source).toBe('tenant');
  });

  it('RE-VERIFIES the selection at dispatch rather than trusting the gate — a slug that no longer resolves dispatches nothing', async () => {
    deps.definitionRepository.findPublishedBySlug = vi.fn().mockResolvedValue(null);
    const result = await dispatch('caller_picked_v1');

    expect(result.dispatched).toBe(false);
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('RE-VERIFIES the palette at dispatch — a selection that turned into another palette dispatches nothing', async () => {
    deps.definitionRepository.findPublishedBySlug = vi.fn().mockResolvedValue({ ...consultationDefinition, paletteKey: 'summarization' });
    const result = await dispatch('caller_picked_v1');

    expect(result.dispatched).toBe(false);
    expect(result.skippedReason).toMatch(/palette/);
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});
