/**
 * TASK-1038 OD-35 (owner decision 2026-10-05) — business-plane run reads are bound to the
 * STARTING principal.
 *
 * An API key or a service account reads only the runs it started, unless it holds the run kind's
 * `…:run:read-all` scope (EXACT grant — a parent, category or `*` scope never implies it). A human
 * JWT that is a SUPER_ADMIN, or a TENANT_ADMIN of the working tenant (read from the tenant-scoped
 * role assignments), reads every run of the tenant; any other human reads only the runs it started.
 * A run with no recorded starter (a webhook run, a row written before OD-35) is readable only
 * tenant-wide.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RUN_READ_ALL_SCOPES,
  RUN_STARTED_BY_KEY,
  RunPrincipalAccessService,
  principalScopedIdempotencyKey,
  readRunStartedBy,
  type RunPrincipal,
} from '../run-principal-access';

const TENANT = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';

type Store = Record<string, unknown>;

function access(store: Store, roles: Array<{ tenantId: string; Roles: Array<{ name: string }> }> | Error = []) {
  const cls = { get: vi.fn((key: string) => store[key]) };
  const roleAssignments = {
    findAll: vi.fn(async () => {
      if (roles instanceof Error) throw roles;
      return roles;
    }),
  };
  return { svc: new RunPrincipalAccessService(cls as never, roleAssignments as never), roleAssignments };
}

const apiKeyA: RunPrincipal = { type: 'apiKey', id: 'key-A' };
const apiKeyB: RunPrincipal = { type: 'apiKey', id: 'key-B' };
const saOne: RunPrincipal = { type: 'serviceAccount', id: 'sa-1' };
const doctor: RunPrincipal = { type: 'user', id: 'doctor-1' };

describe('OD-35 — the principal a request starts a run as', () => {
  it('an API key is its KEY id, never its bound human', () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: [] } });
    expect(svc.currentPrincipal()).toEqual(apiKeyA);
  });

  it('a service account is its account id', () => {
    const { svc } = access({ tenantId: TENANT, serviceAccount: { id: 'sa-1', scopes: [], roles: [] } });
    expect(svc.currentPrincipal()).toEqual(saOne);
  });

  it('a human JWT is its user id', () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'doctor-1' } });
    expect(svc.currentPrincipal()).toEqual(doctor);
  });

  it('no credential at all (a public webhook) is null', () => {
    const { svc } = access({ tenantId: TENANT });
    expect(svc.currentPrincipal()).toBeNull();
  });
});

describe('OD-35 — canRead', () => {
  it('API key A reads the run it started', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: ['workflow:run:read'] } });
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
  });

  it('API key B does NOT read the run key A started — even when both keys are bound to the same tenant admin', async () => {
    const { svc, roleAssignments } = access(
      { tenantId: TENANT, user: { id: 'human-1', roles: ['SUPER_ADMIN'] }, apiKey: { id: 'key-B', scopes: ['workflow:run:read'] } },
      [{ tenantId: TENANT, Roles: [{ name: 'TENANT_ADMIN' }] }],
    );
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
    // A machine credential never widens through the human behind it.
    expect(roleAssignments.findAll).not.toHaveBeenCalled();
  });

  it('a service account does not read a run an API key started, nor the reverse', async () => {
    const sa = access({ tenantId: TENANT, serviceAccount: { id: 'sa-1', scopes: ['svc:workflow:run:read'], roles: ['SUPER_ADMIN'] } });
    await expect(sa.svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
    await expect(sa.svc.canRead('workflow', saOne)).resolves.toBe(true);
    const key = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: [] } });
    await expect(key.svc.canRead('workflow', saOne)).resolves.toBe(false);
  });

  it('the read-all scope of THAT run kind widens a machine credential to the tenant', async () => {
    const key = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-B', scopes: [RUN_READ_ALL_SCOPES.workflow.apiKey] } });
    await expect(key.svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
    await expect(key.svc.canRead('agent', apiKeyA)).resolves.toBe(false);

    const sa = access({ tenantId: TENANT, serviceAccount: { id: 'sa-1', scopes: [RUN_READ_ALL_SCOPES.agent.serviceAccount], roles: [] } });
    await expect(sa.svc.canRead('agent', apiKeyA)).resolves.toBe(true);
    await expect(sa.svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
  });

  it('read-all is an EXACT grant: `*`, `workflow`, `workflow:run`, `workflow:*` and `svc:*` never imply it', async () => {
    for (const scopes of [['*'], ['workflow'], ['workflow:run'], ['workflow:*'], ['workflow:run:read']]) {
      const { svc } = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-B', scopes } });
      await expect(svc.canRead('workflow', apiKeyA), scopes.join(',')).resolves.toBe(false);
    }
    for (const scopes of [['svc:*'], ['svc:workflow'], ['svc:workflow:run:read']]) {
      const { svc } = access({ tenantId: TENANT, serviceAccount: { id: 'sa-2', scopes, roles: [] } });
      await expect(svc.canRead('workflow', saOne), scopes.join(',')).resolves.toBe(false);
    }
  });

  it('a doctor (non-admin human) reads only the runs it started', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'doctor-1', roles: ['DOCTOR'] } }, [{ tenantId: TENANT, Roles: [{ name: 'DOCTOR' }] }]);
    await expect(svc.canRead('workflow', doctor)).resolves.toBe(true);
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
    await expect(svc.canRead('workflow', { type: 'user', id: 'doctor-2' })).resolves.toBe(false);
  });

  it('a TENANT_ADMIN of THIS tenant reads every run of the tenant', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'admin-1' } }, [{ tenantId: TENANT, Roles: [{ name: 'TENANT_ADMIN' }] }]);
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
    await expect(svc.canRead('agent', saOne)).resolves.toBe(true);
    await expect(svc.canRead('workflow', null)).resolves.toBe(true);
  });

  it('a TENANT_ADMIN of ANOTHER tenant is nobody here', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'admin-1' } }, [{ tenantId: OTHER, Roles: [{ name: 'TENANT_ADMIN' }] }]);
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
  });

  it('a super admin (session roles, or an assignment in any tenant) reads every run', async () => {
    const bySession = access({ tenantId: TENANT, user: { id: 'root', roles: ['SUPER_ADMIN'] } });
    await expect(bySession.svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
    expect(bySession.roleAssignments.findAll).not.toHaveBeenCalled();
    const byAssignment = access({ tenantId: TENANT, user: { id: 'root' } }, [
      { tenantId: '00000000-0000-0000-0000-000000000000', Roles: [{ name: 'SUPER_ADMIN' }] },
    ]);
    await expect(byAssignment.svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
  });

  it('fails closed on an unreadable role list: the human falls back to its own runs', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'admin-1' } }, new Error('db down'));
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
    await expect(svc.canRead('workflow', { type: 'user', id: 'admin-1' })).resolves.toBe(true);
  });

  it('a run with no recorded starter is readable only tenant-wide', async () => {
    const key = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: [] } });
    await expect(key.svc.canRead('workflow', null)).resolves.toBe(false);
    const doc = access({ tenantId: TENANT, user: { id: 'doctor-1' } });
    await expect(doc.svc.canRead('workflow', null)).resolves.toBe(false);
  });

  it('no principal at all reads nothing', async () => {
    const { svc } = access({ tenantId: TENANT });
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(false);
  });

  it('a ticket-restored request answers with the reader recorded on the ticket, not the restored human', async () => {
    // A ticket minted by API key A restores only the bound human on `user`; the reader it was
    // minted under rides on CLS `runReader`.
    const { svc } = access({ tenantId: TENANT, user: { id: 'human-1' }, runReader: { principal: apiKeyA, tenantWide: false } });
    await expect(svc.canRead('workflow', apiKeyA)).resolves.toBe(true);
    await expect(svc.canRead('workflow', { type: 'user', id: 'human-1' })).resolves.toBe(false);
  });

  it('resolveReader is what a ticket records', async () => {
    const { svc } = access({ tenantId: TENANT, user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: [RUN_READ_ALL_SCOPES.workflow.apiKey] } });
    await expect(svc.resolveReader('workflow')).resolves.toEqual({ principal: apiKeyA, tenantWide: true });
  });
});

describe('OD-35 — the stamp and the idempotency scope', () => {
  it('reads a well-formed starter from run metadata, and nothing else', () => {
    expect(readRunStartedBy({ [RUN_STARTED_BY_KEY]: apiKeyA })).toEqual(apiKeyA);
    expect(readRunStartedBy({ [RUN_STARTED_BY_KEY]: { type: 'robot', id: 'x' } })).toBeNull();
    expect(readRunStartedBy({ [RUN_STARTED_BY_KEY]: { type: 'apiKey', id: '' } })).toBeNull();
    expect(readRunStartedBy(null)).toBeNull();
    expect(readRunStartedBy({})).toBeNull();
  });

  it('two principals presenting the same Idempotency-Key never address the same run', () => {
    const a = principalScopedIdempotencyKey(apiKeyA, 'k-1');
    const b = principalScopedIdempotencyKey(apiKeyB, 'k-1');
    const h = principalScopedIdempotencyKey(doctor, 'k-1');
    expect(new Set([a, b, h]).size).toBe(3);
    expect(principalScopedIdempotencyKey(apiKeyA, 'k-1')).toBe(a);
  });

  it('a principal-less start (a webhook delivery) keeps its key unchanged', () => {
    expect(principalScopedIdempotencyKey(null, 'delivery-9')).toBe('delivery-9');
  });

  it('the four read-all scopes', () => {
    expect(RUN_READ_ALL_SCOPES).toEqual({
      workflow: { apiKey: 'workflow:run:read-all', serviceAccount: 'svc:workflow:run:read-all' },
      agent: { apiKey: 'agent:run:read-all', serviceAccount: 'svc:agent:run:read-all' },
    });
  });
});

describe('OD-35 — cost', () => {
  it('reading your OWN run never reads the role list', async () => {
    const { svc, roleAssignments } = access({ tenantId: TENANT, user: { id: 'doctor-1' } }, [
      { tenantId: TENANT, Roles: [{ name: 'TENANT_ADMIN' }] },
    ]);
    await expect(svc.canRead('workflow', doctor)).resolves.toBe(true);
    expect(roleAssignments.findAll).not.toHaveBeenCalled();
  });
});
