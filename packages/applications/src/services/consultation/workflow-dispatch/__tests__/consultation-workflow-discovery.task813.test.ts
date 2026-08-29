/**
 * TASK-813 §8 — selectable-set DISCOVERY.
 *
 * The property under test is not "the list returns rows". It is that the list and the
 * gate are ONE predicate with two consumers:
 *
 *   * `assertSelectableForConsultation` answers it for a single slug;
 *   * `listSelectableForConsultation` answers it for the whole tenant.
 *
 * Built as two independent queries they drift, and the failure is silent — a slug the
 * list advertises but the gate refuses, or one the gate allows but the list hides. The
 * `agrees with the gate` block below is the anti-drift test: it asserts the two answers
 * for the SAME definition, so a future edit to either side that does not touch the other
 * fails here rather than in production.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const consultationA = {
  id: 'wd-1',
  slug: 'clinic_intake_v1',
  versionNumber: 3,
  name: 'Clinic Intake',
  description: 'The standard intake graph',
  paletteKey: 'consultation',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};
const consultationB = { ...consultationA, id: 'wd-2', slug: 'telehealth_v2', name: 'Telehealth', description: null };
const summarizer = { ...consultationA, id: 'wd-3', slug: 'summarizer_v1', name: 'Summarizer', paletteKey: 'summarization' };
const sttGraph = { ...consultationA, id: 'wd-4', slug: 'listener_v1', name: 'Listener', paletteKey: 'stt' };

function makeDeps(overrides: Record<string, unknown> = {}) {
  const published = [consultationA, consultationB, summarizer, sttGraph];
  return {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' }) },
    definitionRepository: {
      findActivePublishedByTenant: vi.fn().mockResolvedValue(published),
      findPublishedBySlug: vi.fn(async (_t: string, slug: string) => published.find((d) => d.slug === slug) ?? null),
    },
    consultationRepository: { findById: vi.fn(), update: vi.fn() },
    workflowRunService: { recordRunStarted: vi.fn() },
    harnessGateway: { startWorkflowRun: vi.fn() },
    s3Service: { putFile: vi.fn() },
    sttPipelineResolver: { resolvePipelineId: vi.fn() },
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

describe('listSelectableForConsultation — the discoverable set', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('returns only the consultation-palette definitions', async () => {
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);
    expect(data.map((d) => d.slug)).toEqual(['clinic_intake_v1', 'telehealth_v2']);
  });

  it('scopes the read to the CALLER tenant — the set is never resolved tenant-free', async () => {
    await makeService(deps).listSelectableForConsultation(TENANT);
    expect(deps.definitionRepository.findActivePublishedByTenant).toHaveBeenCalledWith(TENANT);
  });

  it('carries enough to choose, and nothing that describes the graph', async () => {
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);

    expect(data[0]).toEqual({ slug: 'clinic_intake_v1', name: 'Clinic Intake', description: 'The standard intake graph', isTenantDefault: false });
    // No graph, compiledConfig, node list, version id or internal row id reaches the caller.
    expect(Object.keys(data[0]).sort()).toEqual(['description', 'isTenantDefault', 'name', 'slug']);
  });

  it('normalises an absent description to null rather than omitting the field', async () => {
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);
    expect(data.find((d) => d.slug === 'telehealth_v2')?.description).toBeNull();
  });

  it('marks the slug the tenant-level cascade would pick when no selection is made', async () => {
    deps.assignments.resolve = vi.fn().mockResolvedValue({ workflowDefinitionSlug: 'telehealth_v2', source: 'tenant' });
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);

    expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', null);
    expect(data.find((d) => d.slug === 'telehealth_v2')?.isTenantDefault).toBe(true);
    expect(data.find((d) => d.slug === 'clinic_intake_v1')?.isTenantDefault).toBe(false);
  });

  it('marks nothing default when the assignment names a slug that is not itself selectable', async () => {
    // A tenant default that has since been unpublished, or was never a consultation graph. The
    // list must not invent an entry for it — that would advertise a slug the gate refuses.
    deps.assignments.resolve = vi.fn().mockResolvedValue({ workflowDefinitionSlug: 'summarizer_v1', source: 'tenant' });
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);

    expect(data.map((d) => d.slug)).toEqual(['clinic_intake_v1', 'telehealth_v2']);
    expect(data.every((d) => d.isTenantDefault === false)).toBe(true);
  });

  it('still answers when the cascade read fails — the default marker is decoration, not the answer', async () => {
    deps.assignments.resolve = vi.fn().mockRejectedValue(new Error('assignment store unreachable'));
    const { data } = await makeService(deps).listSelectableForConsultation(TENANT);

    expect(data.map((d) => d.slug)).toEqual(['clinic_intake_v1', 'telehealth_v2']);
    expect(data.every((d) => d.isTenantDefault === false)).toBe(true);
  });

  it('returns an empty set — never an error — for a tenant that has authored nothing', async () => {
    deps.definitionRepository.findActivePublishedByTenant = vi.fn().mockResolvedValue([]);
    await expect(makeService(deps).listSelectableForConsultation(TENANT)).resolves.toEqual({ data: [] });
  });
});

describe('the list agrees with the gate — one predicate, two consumers', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('every slug the list advertises passes the gate', async () => {
    const service = makeService(deps);
    const { data } = await service.listSelectableForConsultation(TENANT);

    expect(data).not.toHaveLength(0);
    for (const entry of data) {
      await expect(service.assertSelectableForConsultation(TENANT, entry.slug)).resolves.toBeUndefined();
    }
  });

  it('every published slug the list OMITS is refused by the gate — the list hides nothing selectable', async () => {
    const service = makeService(deps);
    const { data } = await service.listSelectableForConsultation(TENANT);
    const advertised = new Set(data.map((d) => d.slug));

    const omitted = [summarizer, sttGraph].filter((d) => !advertised.has(d.slug));
    expect(omitted).toHaveLength(2);
    for (const definition of omitted) {
      await expect(service.assertSelectableForConsultation(TENANT, definition.slug)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('an invisible slug is in neither answer', async () => {
    const service = makeService(deps);
    const { data } = await service.listSelectableForConsultation(TENANT);

    expect(data.map((d) => d.slug)).not.toContain('other_tenants_workflow');
    await expect(service.assertSelectableForConsultation(TENANT, 'other_tenants_workflow')).rejects.toBeInstanceOf(NotFoundException);
  });
});
