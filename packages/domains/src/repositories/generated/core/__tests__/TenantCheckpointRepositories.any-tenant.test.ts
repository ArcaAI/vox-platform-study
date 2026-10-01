/**
 * TASK-1032 round 2 — the "ANY tenant" scans of the checkpoint sweepers read through the UNSCOPED
 * base client. The scoped delegate here throws exactly like the tenant-scope extension does in a
 * worker without a tenant in context (the live failure of the first checkpoint-worker run).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantCheckpointRepository } from '../TenantCheckpointRepository';
import { TenantCheckpointRestoreRepository } from '../TenantCheckpointRestoreRepository';

const throwing = (model: string) =>
  vi.fn(() => {
    throw new Error(`TenantScope: tenant context required for model ${model} operation findMany`);
  });

function build<R>(Repo: new (uow: never, db: never) => R, delegate: string, model: string) {
  const scoped = throwing(model);
  const unscoped = vi.fn(async () => []);
  const databaseService = { client: { [delegate]: { findMany: scoped } }, baseClient: { [delegate]: { findMany: unscoped } } };
  const unitOfWork = { getDatabaseService: () => databaseService.client, getCoreDatabaseService: () => databaseService };
  return { repo: new Repo(unitOfWork as never, databaseService as never), scoped, unscoped };
}

describe('TenantCheckpointRepository — ANY-tenant scans', () => {
  let t: ReturnType<typeof build<TenantCheckpointRepository>>;
  beforeEach(() => {
    t = build(TenantCheckpointRepository, 'tenantCheckpoint', 'TenantCheckpoint');
  });

  it.each([
    ['findStale', (r: TenantCheckpointRepository) => r.findStale(new Date())],
    ['findExpired', (r: TenantCheckpointRepository) => r.findExpired(new Date())],
    ['findIdleUploads', (r: TenantCheckpointRepository) => r.findIdleUploads(new Date())],
    ['findReadyAnyTenant', (r: TenantCheckpointRepository) => r.findReadyAnyTenant()],
  ])('%s reads unscoped and filters soft-deleted rows itself', async (_name, call) => {
    await expect(call(t.repo)).resolves.toEqual([]);
    expect(t.scoped).not.toHaveBeenCalled();
    expect(t.unscoped).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ resourceStatus: { not: 'DELETED' } }) }));
  });
});

describe('TenantCheckpointRestoreRepository — ANY-tenant scans', () => {
  let t: ReturnType<typeof build<TenantCheckpointRestoreRepository>>;
  beforeEach(() => {
    t = build(TenantCheckpointRestoreRepository, 'tenantCheckpointRestore', 'TenantCheckpointRestore');
  });

  it.each([
    ['findStaleActive', (r: TenantCheckpointRestoreRepository) => r.findStaleActive(new Date())],
    ['findActiveAnyTenant', (r: TenantCheckpointRestoreRepository) => r.findActiveAnyTenant()],
  ])('%s reads unscoped and filters soft-deleted rows itself', async (_name, call) => {
    await expect(call(t.repo)).resolves.toEqual([]);
    expect(t.scoped).not.toHaveBeenCalled();
    expect(t.unscoped).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ resourceStatus: { not: 'DELETED' } }) }));
  });
});
