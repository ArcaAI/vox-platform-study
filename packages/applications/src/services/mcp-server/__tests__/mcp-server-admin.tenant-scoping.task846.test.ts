/**
 * MCP connector tenant scoping (OD-7, 2026-09-01).
 *
 * OWNER DECISION OD-7 reverses the previous "MCP writes are super-admin only"
 * rule: **tenant admins may configure MCP connectors.** The declarative grant
 * already existed (seeded tenant-admin roles hold `manage:McpServer` in CASL);
 * only the imperative `assertSuperAdmin()` overrode it.
 *
 * The posture this file pins is the SYSTEM-vs-tenant-owned SPLIT GATE — the
 * `assertCanApprove` precedent already documented in `05-nestjs-api.md`:
 *
 *   | Row the write targets | Tenant admin | Why |
 *   |----------------------------------|--------------|---------------------------------------|
 *   | SYSTEM (`00000000-…`) registry | **403** | privilege; the row is readable, so |
 *   | | | hiding its existence would be a lie |
 *   | Another customer tenant's row | **404** | 404-over-403 — never leak existence |
 *   | Its OWN tenant's row | allowed | OD-7 |
 *
 * Ordering is load-bearing: existence is resolved BEFORE privilege, so an
 * unknown id is 404 for everyone — a tenant admin must not be able to probe the
 * id space by telling 403 ("exists, not yours") from 404 ("no such row").
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpServerFactory, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';

import { McpServerAdminService } from '../mcp-server-admin.service';

const TENANT = 'tenant-abc';
const OTHER_TENANT = 'tenant-xyz';

function makeRow(tenantId: string, name = 'fhir-terminology') {
  return McpServerFactory.CreateMcpServer({
    tenantId,
    name,
    baseUrl: 'https://terminology.internal/mcp',
    authRef: 'secret/data/mcp/terminology',
    phiBoundary: 'in-boundary',
    enabled: true,
    toolAllowlist: ['validate_codes'],
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
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', tenantId: clsTenantId, roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  // the SSRF egress guard is a REQUIRED constructor dependency.
  // Stubbed permissive here on purpose: this file is about the tenancy/privilege
  // posture, and the guard's own behaviour (range table, allow-list matching,
  // fail-closed) is pinned by `egress-guard.test.ts` +
  // `mcp-server-admin.egress.task846.test.ts` against the shared vector fixture.
  const egressPolicy = { assertUrlAllowed: vi.fn(async () => undefined) };
  const svc = new McpServerAdminService(repo as any, db as any, emitter as any, cls as any, egressPolicy as any);
  return { svc, repo, emitter };
}

/** The controller pins a tenant admin to its own tenant before the service is reached. */
const asTenantAdmin = () => makeService({ roles: ['TENANT_ADMIN'], clsTenantId: TENANT });
const asSuperAdmin = () => makeService({ roles: ['SUPER_ADMIN'], clsTenantId: null });

beforeEach(() => vi.clearAllMocks());

describe(' / OD-7 — a tenant admin may CRUD OWN-TENANT connectors', () => {
  it('create writes a row owned by the CALLER tenant, not the SYSTEM registry', async () => {
    const { svc, repo, emitter } = asTenantAdmin();

    const res = await svc.create({ name: 'local-tools', baseUrl: 'https://tools.local/mcp', phiBoundary: 'in-boundary' } as any, TENANT);

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.tenantId).toBe(TENANT);
    expect(res.tenantId).not.toBe(SYSTEM_TENANT_ID);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: res.id }));
  });

  it('update of an own-tenant row succeeds under CAS and broadcasts ResourceUpdated', async () => {
    const { svc, repo, emitter } = asTenantAdmin();
    const row = makeRow(TENANT);
    repo.findEnabledById.mockResolvedValue(row);

    await svc.update(row.id, { name: 'renamed' } as any, 1, TENANT);

    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, undefined);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: row.id }));
  });

  it('delete of an own-tenant row soft-deletes and broadcasts ResourceDeleted', async () => {
    const { svc, repo, emitter } = asTenantAdmin();
    const row = makeRow(TENANT);
    repo.findEnabledById.mockResolvedValue(row);

    await svc.remove(row.id, 1, TENANT);

    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, undefined);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: row.id }));
  });
});

describe('the SYSTEM registry stays super-admin-only (403, existence NOT hidden)', () => {
  it('a tenant admin updating a SYSTEM-owned row gets 403, not 404', async () => {
    const { svc, repo } = asTenantAdmin();
    // McpServer is a SYSTEM_SHARED_READ model, so the scoped client legitimately
    // RETURNS the SYSTEM row to a tenant admin — it is readable, hence 403.
    repo.findEnabledById.mockResolvedValue(makeRow(SYSTEM_TENANT_ID));

    await expect(svc.update('sys-1', { name: 'x' } as any, 1, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a tenant admin deleting a SYSTEM-owned row gets 403', async () => {
    const { svc, repo } = asTenantAdmin();
    repo.findEnabledById.mockResolvedValue(makeRow(SYSTEM_TENANT_ID));

    await expect(svc.remove('sys-1', 1, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a tenant admin creating INTO the SYSTEM registry gets 403', async () => {
    const { svc, repo } = asTenantAdmin();

    await expect(svc.create({ name: 's', baseUrl: 'https://x/mcp' } as any, SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('a super admin still owns the SYSTEM registry write path', async () => {
    const { svc, repo } = asSuperAdmin();

    const res = await svc.create({ name: 'fhir', baseUrl: 'https://t/mcp', phiBoundary: 'in-boundary' } as any);

    expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});

describe('cross-tenant stays 404 (404-over-403 posture preserved)', () => {
  it('an id belonging to another tenant is 404 — the scoped read simply misses', async () => {
    const { svc, repo } = asTenantAdmin();
    repo.findEnabledById.mockResolvedValue(null); // scoped client: [caller, SYSTEM] ⇒ a foreign row is invisible

    await expect(svc.update('foreign-1', { name: 'x' } as any, 1, TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a foreign row reached through the super-admin base-client lane is still 404 for a tenant admin', async () => {
    const { svc, repo } = asTenantAdmin();
    // Defence in depth: even if a row from another tenant were ever handed back,
    // the gate must not 403 it — that would confirm the row exists.
    repo.findEnabledById.mockResolvedValue(makeRow(OTHER_TENANT));

    await expect(svc.remove('foreign-1', 1, TENANT)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('an UNKNOWN id is 404 for a tenant admin — existence is resolved before privilege', async () => {
    const { svc, repo } = asTenantAdmin();
    repo.findEnabledById.mockResolvedValue(null);

    // Pre-OD-7 this threw 403 before ever looking the row up, which let a caller
    // distinguish "no such id" from "exists but not yours". It must not.
    await expect(svc.update('missing', { name: 'x' } as any, 1, TENANT)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('missing', 1, TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('secret hygiene survives tenant-scoped writes', () => {
  it('a tenant-admin create stores and echoes a Vault PATH only — never credential material', async () => {
    const { svc, repo } = asTenantAdmin();

    const res = await svc.create(
      { name: 'byo', baseUrl: 'https://byo.local/mcp', authRef: 'secret/data/mcp/byo', phiBoundary: 'in-boundary' } as any,
      TENANT,
    );

    expect(res.authRef).toBe('secret/data/mcp/byo');
    expect(repo.create.mock.calls[0][0].authRef).toBe('secret/data/mcp/byo');
    // The model has no column that could hold a bearer/OAuth token.
    expect(JSON.stringify(res)).not.toMatch(/token|password|bearer|apikey|api_key|secret_id|client_secret/i);
  });
});
