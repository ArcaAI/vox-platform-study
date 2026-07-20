/**
 * McpServerAdminService — unit tests.
 *
 * Mirrors the `ai-task-default` test style: repository, EventEmitter2 and
 * ClsService are mocked. Asserts the GLOBAL-ADMIN-only write governance (403 for
 * tenant admins), OCC semantics, cross-tenant 404 reads, sys-event broadcasting,
 * and — security-critical — that NO secret material is stored or echoed
 * (authRef is a Vault path only; the model has no secret column).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { McpServerFactory, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';

import { McpServerAdminService } from '../mcp-server-admin.service';

const TENANT = 'tenant-abc';

function makeRow(overrides: Partial<{ tenantId: string; name: string; enabled: boolean; phiBoundary: string; authRef: string | null }> = {}) {
  return McpServerFactory.CreateMcpServer({
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    name: overrides.name ?? 'fhir-terminology',
    baseUrl: 'https://terminology.internal/mcp',
    authRef: overrides.authRef ?? 'secret/data/mcp/terminology',
    phiBoundary: overrides.phiBoundary ?? 'in-boundary',
    enabled: overrides.enabled ?? true,
    toolAllowlist: ['validate_code'],
  });
}

function makeService(opts: { roles?: string[]; clsTenantId?: string | null } = {}) {
  const repo = {
    findByTenantAndName: vi.fn().mockResolvedValue(null),
    findEnabledById: vi.fn().mockResolvedValue(null),
    listEnabled: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: any, e: any) => e),
  };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const svc = new McpServerAdminService(repo as any, db as any, emitter as any, cls as any);
  return { svc, repo, emitter, db };
}

describe('McpServerAdminService — write governance (GLOBAL-ADMIN only)', () => {
  it('a tenant admin creating a server gets 403 (privilege boundary, not 404)', async () => {
    const { svc, repo } = makeService({ roles: [] });
    await expect(svc.create({ name: 's', baseUrl: 'https://x/mcp' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('a tenant admin updating a server gets 403', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.update('id-1', { name: 'x' } as any, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a tenant admin deleting a server gets 403', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.remove('id-1', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a global admin can create a SYSTEM registry row + broadcasts ResourceCreated', async () => {
    const { svc, repo, emitter } = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    const res = await svc.create({ name: 'fhir-terminology', baseUrl: 'https://terminology.internal/mcp', phiBoundary: 'in-boundary' } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
    // Cross-tenant lane: SYSTEM target ≠ CLS tenant (null) ⇒ routed via the base client.
    expect(repo.create.mock.calls[0][1]).toEqual({ $lane: 'unscoped-base-client' });
    expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: res.id }));
  });
});

describe('McpServerAdminService — secret hygiene', () => {
  it('never echoes secret material — authRef is only ever a Vault path', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    const res = await svc.create({
      name: 'svc',
      baseUrl: 'https://x/mcp',
      authRef: 'secret/data/mcp/svc',
      phiBoundary: 'in-boundary',
    } as any);
    // The response carries the Vault PATH, not a token. No secret-bearing field exists.
    expect(res.authRef).toBe('secret/data/mcp/svc');
    expect(JSON.stringify(res)).not.toMatch(/token|password|bearer|apikey|api_key/i);
    // The persisted entity likewise stores only the path.
    const persisted = repo.create.mock.calls[0][0];
    expect(persisted.authRef).toBe('secret/data/mcp/svc');
  });
});

describe('McpServerAdminService — OCC + cross-tenant 404', () => {
  it('update without an If-Match version raises OptimisticConcurrencyException', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    repo.findEnabledById.mockResolvedValue(makeRow());
    await expect(svc.update('id-1', { name: 'renamed' } as any, undefined)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('update CASes with the supplied version + broadcasts ResourceUpdated', async () => {
    const { svc, repo, emitter } = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    const row = makeRow();
    repo.findEnabledById.mockResolvedValue(row);
    await svc.update(row.id, { name: 'renamed' } as any, 1);
    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, { $lane: 'unscoped-base-client' });
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: row.id }));
  });

  it('get of an absent / cross-tenant server is 404 (no existence leak)', async () => {
    const { svc, repo } = makeService({ roles: [] });
    repo.findEnabledById.mockResolvedValue(null);
    await expect(svc.get('missing', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list returns the SYSTEM-shared registry (extended-client widening path)', async () => {
    const { svc, repo } = makeService({ roles: [] });
    repo.listEnabled.mockResolvedValue([makeRow()]);
    const res = await svc.list(TENANT);
    // Tenant admin ⇒ no cross-tenant lane ⇒ listEnabled() called with no explicit scope.
    expect(repo.listEnabled).toHaveBeenCalledWith();
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('fhir-terminology');
  });

  it('remove soft-deletes via CAS + broadcasts ResourceDeleted', async () => {
    const { svc, repo, emitter } = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    const row = makeRow();
    repo.findEnabledById.mockResolvedValue(row);
    await svc.remove(row.id, 1);
    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, { $lane: 'unscoped-base-client' });
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: row.id }));
  });
});
