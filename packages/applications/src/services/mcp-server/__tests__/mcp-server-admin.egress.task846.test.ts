/**
 * SSRF egress guard at MCP connector WRITE time.
 *
 * OD-7 let tenant admins author `McpServer.baseUrl`, and the harness worker connects to
 * whatever that field says. Inside a k3s cluster that reaches the Kubernetes API, Vault on
 * loopback, and the cloud metadata endpoint — SSRF with a tenant as the attacker.
 *
 * This file pins the WRITE-time half only. Write-time exists for FEEDBACK: it tells an
 * admin immediately that a URL will never work. It is NOT the protection — DNS can change
 * after the row is saved, so the authoritative gate is the harness's CALL-time check
 * (`apps/harness/src/harness/tools/egress_guard.py`, pinned by `test_egress_guard.py`).
 * Both sides read the same vector fixture.
 *
 * NOT re-tested here (owned by `egress-guard.test.ts` against the shared fixture): the
 * range table, the allow-list matching rules, the IPv6 unwrapping. This file asserts only
 * that the admin service actually CONSULTS the guard, on both write paths, and refuses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { McpServerFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';

import { McpServerAdminService } from '../mcp-server-admin.service';

const TENANT = 'tenant-abc';
const ALLOWED_URL = 'https://mcp.partner.example.com/mcp';
const BLOCKED_URL = 'http://169.254.169.254/latest/meta-data/';

function makeService(opts: { egressAllows?: boolean; egressThrows?: Error; roles?: string[]; clsTenantId?: string | null } = {}) {
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
    get: vi.fn((k: string) =>
      k === 'user' ? { id: 'u1', tenantId: clsTenantId, roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined,
    ),
  };
  const db = { baseClient: {} };

  const egress = {
    assertUrlAllowed: vi.fn(async () => {
      if (opts.egressThrows) throw opts.egressThrows;
      if (opts.egressAllows === false) throw new ArgumentInvalidException('blocked by egress policy');
      return undefined;
    }),
  };

  const svc = new McpServerAdminService(repo as any, db as any, emitter as any, cls as any, egress as any);
  return { svc, repo, emitter, egress };
}

function existingRow() {
  const row = McpServerFactory.CreateMcpServer({
    tenantId: TENANT,
    name: 'fhir-terminology',
    baseUrl: ALLOWED_URL,
    authRef: 'secret/data/mcp/terminology',
    phiBoundary: 'external',
    enabled: true,
    toolAllowlist: ['validate_codes'],
  });
  return row;
}

describe('McpServerAdminService — egress guard on CREATE', () => {
  it('consults the egress guard with the submitted baseUrl before persisting', async () => {
    const { svc, repo, egress } = makeService();
    await svc.create({ name: 'partner', baseUrl: ALLOWED_URL, phiBoundary: 'external' } as any, TENANT);

    expect(egress.assertUrlAllowed).toHaveBeenCalledTimes(1);
    expect(egress.assertUrlAllowed.mock.calls[0]![0]).toBe(ALLOWED_URL);
    expect(repo.create).toHaveBeenCalled();
  });

  it('refuses the write when the guard denies — and NOTHING is persisted', async () => {
    const { svc, repo, emitter } = makeService({ egressAllows: false });

    await expect(svc.create({ name: 'evil', baseUrl: BLOCKED_URL, phiBoundary: 'external' } as any, TENANT)).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );

    // The whole point: a refused URL never reaches the database, and never
    // announces itself as a created resource.
    expect(repo.create).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('checks egress BEFORE the duplicate-name lookup — an unreachable URL is refused regardless of naming', async () => {
    const { svc, repo } = makeService({ egressAllows: false });
    await expect(svc.create({ name: 'evil', baseUrl: BLOCKED_URL } as any, TENANT)).rejects.toThrow();
    expect(repo.findByTenantAndName).not.toHaveBeenCalled();
  });

  it('a SUPER ADMIN writing the SYSTEM registry is subject to the SAME guard', async () => {
    // The allow-list is a PLATFORM egress boundary, not a tenant permission check —
    // privilege does not make 169.254.169.254 safe to reach. This caller clears
    // `assertCanWriteTenant` outright, so the only thing that can stop it is egress.
    const { svc, repo, egress } = makeService({ egressAllows: false, roles: ['SUPER_ADMIN'], clsTenantId: null });
    await expect(svc.create({ name: 'evil', baseUrl: BLOCKED_URL } as any, SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(egress.assertUrlAllowed).toHaveBeenCalledTimes(1);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('McpServerAdminService — egress guard on UPDATE', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consults the guard when baseUrl is being changed', async () => {
    const { svc, repo, egress } = makeService();
    const row = existingRow();
    repo.findEnabledById.mockResolvedValue(row);

    await svc.update(row.id, { baseUrl: 'https://mcp.partner.example.com/v2' } as any, row.version, TENANT);

    expect(egress.assertUrlAllowed).toHaveBeenCalledTimes(1);
    expect(egress.assertUrlAllowed.mock.calls[0]![0]).toBe('https://mcp.partner.example.com/v2');
  });

  it('refuses the update when the guard denies — no CAS write, no event', async () => {
    const { svc, repo, emitter } = makeService({ egressAllows: false });
    const row = existingRow();
    repo.findEnabledById.mockResolvedValue(row);

    await expect(svc.update(row.id, { baseUrl: BLOCKED_URL } as any, row.version, TENANT)).rejects.toBeInstanceOf(ArgumentInvalidException);

    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('does NOT consult the guard when baseUrl is absent from the patch', async () => {
    // Re-validating an unchanged URL on every unrelated PATCH would make a
    // transient DNS failure block edits to the NAME field.
    const { svc, repo, egress } = makeService();
    const row = existingRow();
    repo.findEnabledById.mockResolvedValue(row);

    await svc.update(row.id, { description: 'renamed' } as any, row.version, TENANT);

    expect(egress.assertUrlAllowed).not.toHaveBeenCalled();
  });

  it('runs the guard AFTER the row is resolved, so an unknown id is still 404 (no existence oracle)', async () => {
    const { svc, egress } = makeService({ egressAllows: false });
    // findEnabledById already returns null by default.
    await expect(svc.update('no-such-id', { baseUrl: BLOCKED_URL } as any, 1, TENANT)).rejects.toThrow(/not found/i);
    expect(egress.assertUrlAllowed).not.toHaveBeenCalled();
  });
});
