/**
 * TenantNlpTaskInstructionsService — unit tests (TASK-729).
 *
 * Mirrors the `ai-task-default`/`tenant-frontend-config` test style:
 * repository, EventEmitter2 and ClsService are mocked. Asserts: taskKey
 * restriction to nlp.topic/nlp.intent, create-vs-update OCC semantics
 * (mirrors AiTaskDefaultService — expectedVersion:0 for create, required for
 * update), the version:0 placeholder for an unset row, and sys-event
 * broadcasting on every mutation.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SysEventType, TenantNlpTaskInstructionsFactory } from '@arcaai/domains';
import { TenantNlpTaskInstructionsService } from '../tenant-nlp-task-instructions.service';

const TENANT = 'tenant-abc';

function makeRow(overrides: { tenantId?: string; taskKey?: string; instructionsJson?: string[] | null } = {}) {
  return TenantNlpTaskInstructionsFactory.CreateTenantNlpTaskInstructions({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'nlp.topic',
    instructionsJson: overrides.instructionsJson ?? ['billing', 'appointments'],
  });
}

function makeService(opts: { clsTenantId?: string | null; user?: { id: string; roles: string[] } | null } = {}) {
  const repo = { findByTenantAndTaskKey: vi.fn().mockResolvedValue(null), create: vi.fn(), updateWithVersion: vi.fn() };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const user = opts.user === undefined ? { id: 'u1', roles: [] } : opts.user;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? user : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const svc = new TenantNlpTaskInstructionsService(repo as any, emitter as any, cls as any);
  return { svc, repo, emitter };
}

describe('TenantNlpTaskInstructionsService', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  describe('taskKey restriction', () => {
    it('rejects an unknown taskKey on getRow', async () => {
      await expect(ctx.svc.getRow('nlp.classification')).rejects.toThrow(ArgumentInvalidException);
    });

    it('rejects an unknown taskKey on upsertRow', async () => {
      await expect(ctx.svc.upsertRow('nlp.ner', { instructionsJson: ['x'], expectedVersion: 0 })).rejects.toThrow(ArgumentInvalidException);
    });

    it('accepts nlp.topic and nlp.intent', async () => {
      await expect(ctx.svc.getRow('nlp.topic')).resolves.toBeDefined();
      await expect(ctx.svc.getRow('nlp.intent')).resolves.toBeDefined();
    });
  });

  describe('getRow', () => {
    it('returns a version:0 placeholder when no row exists', async () => {
      const result = await ctx.svc.getRow('nlp.topic');
      expect(result).toEqual({ tenantId: TENANT, taskKey: 'nlp.topic', instructionsJson: null, version: 0 });
      expect(ctx.emitter.emit).not.toHaveBeenCalled();
    });

    it('returns the persisted row and broadcasts ResourceViewed', async () => {
      const row = makeRow();
      ctx.repo.findByTenantAndTaskKey.mockResolvedValue(row);

      const result = await ctx.svc.getRow('nlp.topic');

      expect(result.instructionsJson).toEqual(['billing', 'appointments']);
      expect(result.version).toBe(row.version);
      expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: row.id }));
    });
  });

  describe('upsertRow — create', () => {
    it('creates a row and broadcasts ResourceCreated when none exists', async () => {
      ctx.repo.create.mockImplementation(async (entity: any) => entity);

      const result = await ctx.svc.upsertRow('nlp.topic', { instructionsJson: ['billing'], expectedVersion: 0 });

      expect(ctx.repo.create).toHaveBeenCalledTimes(1);
      expect(result.instructionsJson).toEqual(['billing']);
      expect(ctx.emitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: { taskKey: 'nlp.topic', instructionsJson: ['billing'] } }),
      );
    });

    it('rejects a create attempt with a non-zero expectedVersion (OCC)', async () => {
      await expect(ctx.svc.upsertRow('nlp.topic', { instructionsJson: ['billing'], expectedVersion: 3 })).rejects.toThrow(OptimisticConcurrencyException);
      expect(ctx.repo.create).not.toHaveBeenCalled();
    });
  });

  describe('upsertRow — update', () => {
    it('updates an existing row under a matching expectedVersion and broadcasts ResourceUpdated', async () => {
      const existing = makeRow({ instructionsJson: ['old'] });
      ctx.repo.findByTenantAndTaskKey.mockResolvedValue(existing);
      ctx.repo.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await ctx.svc.upsertRow('nlp.topic', { instructionsJson: ['new-topic'], expectedVersion: existing.version });

      expect(ctx.repo.updateWithVersion).toHaveBeenCalledWith(existing.id, existing, existing.version);
      expect(result.instructionsJson).toEqual(['new-topic']);
      expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    });

    it('requires expectedVersion on an update (versionless write refused)', async () => {
      const existing = makeRow();
      ctx.repo.findByTenantAndTaskKey.mockResolvedValue(existing);

      await expect(ctx.svc.upsertRow('nlp.topic', { instructionsJson: ['new-topic'] })).rejects.toThrow(OptimisticConcurrencyException);
      expect(ctx.repo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('rejects a no-op update (no instructionsJson change, no requestUser to stamp updatedBy)', async () => {
      // BaseService.updateEntity stamps `updatedBy` from the request user, which
      // itself registers as a tracked change — so an authenticated no-op call
      // would legitimately proceed (only updatedBy changes). To isolate the
      // "genuinely nothing changed" guard, this case runs unauthenticated
      // (mirrors a system/internal caller), where updatedBy is never stamped.
      ctx = makeService({ user: null });
      const existing = makeRow({ instructionsJson: ['same'] });
      ctx.repo.findByTenantAndTaskKey.mockResolvedValue(existing);

      await expect(ctx.svc.upsertRow('nlp.topic', { expectedVersion: existing.version })).rejects.toThrow(ArgumentInvalidException);
      expect(ctx.repo.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('tenant scoping', () => {
    it('throws when no tenant can be resolved', async () => {
      ctx = makeService({ clsTenantId: null });
      await expect(ctx.svc.getRow('nlp.topic')).rejects.toThrow('Tenant ID is required');
    });

    it('uses the explicit tenantId over the CLS tenant', async () => {
      await ctx.svc.getRow('nlp.topic', 'other-tenant');
      expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith('other-tenant', 'nlp.topic');
    });
  });
});
