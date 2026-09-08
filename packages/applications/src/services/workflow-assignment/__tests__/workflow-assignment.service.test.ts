/**
 * assignment CRUD: referential validation at write time, the
 * WORM change row on every mutation, and 404-over-403 for a foreign id.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PipelinePolicyScope, SysEventType } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowAssignmentService } from '../workflow-assignment.service';

const TENANT = 'tenant-a';
const DEPARTMENT = 'dept-radiology';
// A palette that IS registered in the code-owned node registry — a free string
// is rejected, which is the point of the check.
const PALETTE = 'core';

function makeService(opts: { existing?: unknown; published?: boolean; department?: { tenantId: string } | null; byId?: unknown } = {}) {
  const assignmentRepository = {
    findForScope: vi.fn(async () => opts.existing ?? null),
    findForScopeSelector: vi.fn(async () => opts.existing ?? null),
    findAllForScope: vi.fn(async () => (opts.existing ? [opts.existing] : [])),
    findAllForPalette: vi.fn(async () => []),
    findById: vi.fn(async () => opts.byId ?? null),
    create: vi.fn(async (entity: { id: string; version: number; workflowDefinitionSlug: string; paletteKey: string }) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
    softDelete: vi.fn(async () => opts.byId),
  };
  const changeRepository = { create: vi.fn(async (entity: unknown) => entity) };
  const workflowDefinitionRepository = {
    findPublishedBySlug: vi.fn(async (_t: string, slug: string) => (opts.published === false ? null : { slug, paletteKey: PALETTE })),
  };
  const departmentRepository = { findById: vi.fn(async () => (opts.department === undefined ? { tenantId: TENANT } : opts.department)) };
  const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

  const service = new WorkflowAssignmentService(
    assignmentRepository as never,
    changeRepository as never,
    workflowDefinitionRepository as never,
    departmentRepository as never,
    databaseService as never,
    new EventEmitter2(),
    cls as never,
  );
  // `BaseService.tenantId` reads CLS; the fake above answers `tenantId`.
  return { service, assignmentRepository, changeRepository, workflowDefinitionRepository, departmentRepository };
}

const baseDto = {
  scope: PipelinePolicyScope.DEPARTMENT,
  scopeId: DEPARTMENT,
  paletteKey: PALETTE,
  workflowDefinitionSlug: 'radiology-note',
};

describe('WorkflowAssignmentService.upsert', () => {
  it('creates through the factory and appends a WORM change row in the same transaction', async () => {
    const { service, assignmentRepository, changeRepository } = makeService();
    const emit = vi.spyOn(service as unknown as { broadcastSysEvent: (t: string, p: unknown) => void }, 'broadcastSysEvent');

    const result = await service.upsert({ ...baseDto });

    expect(result.workflowDefinitionSlug).toBe('radiology-note');
    expect(assignmentRepository.create).toHaveBeenCalledOnce();
    expect(changeRepository.create).toHaveBeenCalledOnce();
    const change = changeRepository.create.mock.calls[0][0] as { beforeSlug: string | null; afterSlug: string | null };
    expect(change.beforeSlug).toBeNull();
    expect(change.afterSlug).toBe('radiology-note');
    expect(emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('rejects a slug with no PUBLISHED definition on that palette', async () => {
    const { service } = makeService({ published: false });
    await expect(service.upsert({ ...baseDto })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unregistered palette', async () => {
    const { service } = makeService();
    await expect(service.upsert({ ...baseDto, paletteKey: 'not-a-palette' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a DOCTOR-scope assignment (deliberately out of scope)', async () => {
    const { service } = makeService();
    await expect(service.upsert({ ...baseDto, scope: PipelinePolicyScope.DOCTOR })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 — never 403 — for a department belonging to another tenant', async () => {
    const { service } = makeService({ department: { tenantId: 'tenant-b' } });
    await expect(service.upsert({ ...baseDto })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WorkflowAssignmentService.getById', () => {
  it('returns 404 — never 403 — for another tenant’s assignment id', async () => {
    const { service } = makeService({ byId: { id: 'x', tenantId: 'tenant-b' } });
    await expect(service.getById('x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WorkflowAssignmentService.remove', () => {
  it('soft-deletes and appends a change row with a null afterSlug', async () => {
    const row = {
      id: 'assignment-1',
      tenantId: TENANT,
      scope: PipelinePolicyScope.DEPARTMENT,
      scopeId: DEPARTMENT,
      paletteKey: PALETTE,
      workflowDefinitionSlug: 'radiology-note',
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, assignmentRepository, changeRepository } = makeService({ byId: row });

    await service.remove('assignment-1', 3, 'reassigned');

    expect(assignmentRepository.softDelete).toHaveBeenCalled();
    const change = changeRepository.create.mock.calls[0][0] as { beforeSlug: string | null; afterSlug: string | null; reason: string | null };
    expect(change.beforeSlug).toBe('radiology-note');
    expect(change.afterSlug).toBeNull();
    expect(change.reason).toBe('reassigned');
  });
});
