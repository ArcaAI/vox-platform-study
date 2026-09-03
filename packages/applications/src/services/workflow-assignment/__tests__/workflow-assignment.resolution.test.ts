/**
 * assignment RESOLUTION.
 *
 * The declared order is `department override → tenant default → platform
 * default`, walked with `walkCascade` (first-set-wins), the SAME primitive
 * `ConfigResolver.resolveOne` uses. These tests pin the ORDER and the
 * observable behaviour, not the mechanics.
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
}

function makeService(opts: { rows?: FakeRow[]; publishedSlugs?: string[] } = {}) {
  const rows = opts.rows ?? [];
  const publishedSlugs = new Set(opts.publishedSlugs ?? []);

  const assignmentRepository = {
    findForScope: vi.fn(async (tenantId: string, scope: PipelinePolicyScope, scopeId: string | null, paletteKey: string) => {
      return rows.find((r) => r.tenantId === tenantId && r.scope === scope && r.scopeId === scopeId && r.paletteKey === paletteKey) ?? null;
    }),
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

function row(scope: PipelinePolicyScope, scopeId: string | null, slug: string, tenantId = TENANT): FakeRow {
  return { tenantId, scope, scopeId, paletteKey: PALETTE, workflowDefinitionSlug: slug };
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
    });
    // The DEPARTMENT tier is not even queried when there is no department.
    expect(assignmentRepository.findForScope).not.toHaveBeenCalledWith(TENANT, PipelinePolicyScope.DEPARTMENT, expect.anything(), PALETTE);
  });

  it('falls through to the platform default when no tier has an opinion', async () => {
    const { service } = makeService();

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: null,
      source: 'platform-default',
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
    });
    expect(logSpy).toHaveBeenCalled();
  });

  it('never resolves another tenant’s assignment for a foreign departmentId', async () => {
    const { service } = makeService({
      // A DEPARTMENT row that belongs to a DIFFERENT tenant, keyed by the same
      // department id. Resolving for TENANT must behave as if it is absent.
      rows: [row(PipelinePolicyScope.DEPARTMENT, DEPARTMENT, 'other-tenant-note', OTHER_TENANT), row(PipelinePolicyScope.TENANT, null, 'house-note')],
      publishedSlugs: ['house-note'],
    });

    await expect(service.resolve(TENANT, PALETTE, DEPARTMENT)).resolves.toEqual({
      workflowDefinitionSlug: 'house-note',
      source: 'tenant',
    });
  });
});
