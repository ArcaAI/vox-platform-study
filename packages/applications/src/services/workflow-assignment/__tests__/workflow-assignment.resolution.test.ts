/**
 * assignment RESOLUTION.
 *
 * The declared order is `department override → tenant default → platform
 * default`. WITHIN the department/tenant tiers, TASK-891 adds a `key:value`
 * tag selector (mirrors `AgentAssignmentService.resolve`'s TASK-884 walk): the
 * rows whose selector is a SUBSET of the request's tags, most specific first,
 * unqualified last. These tests pin the ORDER, the selector semantics, and
 * the observable behaviour — not the mechanics.
 */
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PipelinePolicyScope } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowAssignmentService } from '../workflow-assignment.service';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const DEPARTMENT = 'dept-radiology';
const PALETTE = 'consultation';

interface FakeRow {
  tenantId: string;
  scope: PipelinePolicyScope;
  scopeId: string | null;
  paletteKey: string;
  workflowDefinitionSlug: string;
  selectorKey: string;
}

function makeService(opts: { rows?: FakeRow[]; publishedSlugs?: string[] } = {}) {
  const rows = opts.rows ?? [];
  const publishedSlugs = new Set(opts.publishedSlugs ?? []);

  const assignmentRepository = {
    findForScope: vi.fn(async (tenantId: string, scope: PipelinePolicyScope, scopeId: string | null, paletteKey: string) => {
      return (
        rows.find((r) => r.tenantId === tenantId && r.scope === scope && r.scopeId === scopeId && r.paletteKey === paletteKey && r.selectorKey === '') ??
        null
      );
    }),
    // One tier's rows — the unqualified one plus every tag-qualified variant, ordered by
    // `selectorKey desc` the way the real repository does (mirrors `AgentAssignmentRepository`).
    findAllForScope: vi.fn(async (tenantId: string, scope: PipelinePolicyScope, scopeId: string | null, paletteKey: string) => {
      return rows
        .filter((r) => r.tenantId === tenantId && r.scope === scope && r.scopeId === scopeId && r.paletteKey === paletteKey)
        .sort((a, b) => b.selectorKey.localeCompare(a.selectorKey));
    }),
    findForScopeSelector: vi.fn(),
    findAllForPalette: vi.fn(async () => []),
    findById: vi.fn(),
    create: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
  };

  const changeRepository = { create: vi.fn() };

  const workflowDefinitionRepository = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === TENANT && publishedSlugs.has(slug) ? { slug, paletteKey: PALETTE, tenantId } : null,
    ),
  };

  const departmentRepository = { findById: vi.fn() };
  const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
  const cls = { get: vi.fn(() => undefined) };

  const service = new WorkflowAssignmentService(
    assignmentRepository as never,
    changeRepository as never,
    workflowDefinitionRepository as never,
    departmentRepository as never,
    databaseService as never,
    new EventEmitter2(),
    cls as never,
  );

  return { service, assignmentRepository, workflowDefinitionRepository };
}

function row(scope: PipelinePolicyScope, scopeId: string | null, slug: string, selectorKey = '', tenantId = TENANT): FakeRow {
  return { tenantId, scope, scopeId, paletteKey: PALETTE, workflowDefinitionSlug: slug, selectorKey };
}

describe('WorkflowAssignmentService.resolve — department → tenant → platform default', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('prefers the department assignment over the tenant default', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.DEPARTMENT, DEPARTMENT, 'radiology-note'), row(PipelinePolicyScope.TENANT, null, 'house-note')],
      publishedSlugs: ['radiology-note', 'house-note'],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: 'radiology-note',
      source: 'department',
      selector: [],
    });
  });

  it('falls back to the tenant default when the department has no assignment', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.TENANT, null, 'house-note')],
      publishedSlugs: ['house-note'],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: 'house-note',
      source: 'tenant',
      selector: [],
    });
  });

  it('resolves at the tenant tier for a consultation with no department', async () => {
    const { service, assignmentRepository } = makeService({
      rows: [row(PipelinePolicyScope.TENANT, null, 'house-note')],
      publishedSlugs: ['house-note'],
    });

    await expect(service.resolve(TENANT, PALETTE, undefined)).resolves.toEqual({
      workflowDefinitionSlug: 'house-note',
      source: 'tenant',
      selector: [],
    });
    // The DEPARTMENT tier is not even queried when there is no department.
    expect(assignmentRepository.findAllForScope).not.toHaveBeenCalledWith(TENANT, PipelinePolicyScope.DEPARTMENT, expect.anything(), PALETTE);
  });

  it('falls through to the platform default when no tier has an opinion', async () => {
    const { service } = makeService();

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: null,
      source: 'platform-default',
      selector: [],
    });
  });

  it('falls through to the platform default — with an observable warning — when the assigned slug has no PUBLISHED version', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.DEPARTMENT, DEPARTMENT, 'deleted-note')],
      publishedSlugs: [],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: null,
      source: 'platform-default',
      selector: [],
    });
    expect(logSpy).toHaveBeenCalled();
  });

  it('never resolves another tenant’s assignment for a foreign departmentId', async () => {
    const { service } = makeService({
      // A DEPARTMENT row that belongs to a DIFFERENT tenant, keyed by the same
      // department id. Resolving for TENANT must behave as if it is absent.
      rows: [row(PipelinePolicyScope.DEPARTMENT, DEPARTMENT, 'other-tenant-note', '', OTHER_TENANT), row(PipelinePolicyScope.TENANT, null, 'house-note')],
      publishedSlugs: ['house-note'],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: 'house-note',
      source: 'tenant',
      selector: [],
    });
  });
});

describe('WorkflowAssignmentService.resolve — TASK-891 selector-tag matching', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('a request with no tags sees exactly the unqualified row, even when a tag-qualified row exists in the same tier', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.TENANT, null, 'soap-default'), row(PipelinePolicyScope.TENANT, null, 'soap-revisit', 'visit-type:revisit')],
      publishedSlugs: ['soap-default', 'soap-revisit'],
    });

    await expect(service.resolve(TENANT, PALETTE, undefined)).resolves.toEqual({
      workflowDefinitionSlug: 'soap-default',
      source: 'tenant',
      selector: [],
    });
  });

  it('a matching visit-type tag selects the more specific row over the unqualified one', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.TENANT, null, 'soap-default'), row(PipelinePolicyScope.TENANT, null, 'soap-revisit', 'visit-type:revisit')],
      publishedSlugs: ['soap-default', 'soap-revisit'],
    });

    await expect(service.resolve(TENANT, PALETTE, undefined, ['visit-type:revisit'])).resolves.toEqual({
      workflowDefinitionSlug: 'soap-revisit',
      source: 'tenant',
      selector: ['visit-type:revisit'],
    });
  });

  it('a tag that matches nothing in the tier falls back to that tier’s unqualified row', async () => {
    const { service } = makeService({
      rows: [row(PipelinePolicyScope.TENANT, null, 'soap-default'), row(PipelinePolicyScope.TENANT, null, 'soap-revisit', 'visit-type:revisit')],
      publishedSlugs: ['soap-default', 'soap-revisit'],
    });

    await expect(service.resolve(TENANT, PALETTE, undefined, ['visit-type:new-visit'])).resolves.toEqual({
      workflowDefinitionSlug: 'soap-default',
      source: 'tenant',
      selector: [],
    });
  });

  it('tier order still wins over selector specificity: an unqualified DEPARTMENT row beats a tag-matching TENANT row', async () => {
    const { service } = makeService({
      rows: [
        row(PipelinePolicyScope.DEPARTMENT, DEPARTMENT, 'radiology-note'),
        row(PipelinePolicyScope.TENANT, null, 'soap-revisit', 'visit-type:revisit'),
      ],
      publishedSlugs: ['radiology-note', 'soap-revisit'],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT, ['visit-type:revisit'])).resolves.toEqual({
      workflowDefinitionSlug: 'radiology-note',
      source: 'department',
      selector: [],
    });
  });
});
