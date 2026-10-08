/**
 * TASK-1050 W2e — the admin read plane over a consultation's guardrail evaluations (README §9.6,
 * §9.7.6): a keyset-paged list with NO content, and the withheld output of an outbound block,
 * decrypted only for the Prompt Inspector audience (super admin, tenant admin of the working tenant,
 * service account — a doctor is 403), another tenant's consultation 404.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { GuardrailDecision, GuardrailDirection, GuardrailEvaluationFactory } from '@arcaai/domains';
import { decodeCursor } from '../../../common/cursorPagination';
import { GuardrailEvaluationAdminService } from '../guardrail-evaluation-admin.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';

function evaluation(id: string, minute: number, withheld = false, checksOverride?: unknown[]) {
  return GuardrailEvaluationFactory.CreateGuardrailEvaluation({
    id,
    tenantId: TENANT,
    requestId: 'req-1',
    consultationId: CONSULTATION,
    caller: 'harness.guardrail_check',
    direction: withheld ? GuardrailDirection.OUTBOUND : GuardrailDirection.INBOUND,
    decision: withheld ? GuardrailDecision.BLOCK : GuardrailDecision.WARN,
    checks: (checksOverride ?? [{ checkId: 'leakage_judge', verdict: 'flag', actionTaken: withheld ? 'block' : 'warn', model: 'granite', latencyMs: 9, regionKeys: ['response'], items: [] }]) as never,
    policyVersion: 'pv-1',
    noticeIds: ['n-1'],
    encryptedWithheldContent: withheld ? Buffer.from('vault:v2:c2VjcmV0', 'utf8') : null,
    keyVersion: withheld ? 2 : null,
    at: new Date(Date.UTC(2026, 9, 7, 9, minute)),
  });
}

function makeHarness(opts: { caller?: 'super' | 'tenant-admin' | 'doctor' | 'service-account'; rows?: ReturnType<typeof evaluation>[] } = {}) {
  const rows = opts.rows ?? [evaluation('e-3', 3), evaluation('e-2', 2), evaluation('e-1', 1, true)];
  const consultations = {
    findByIdOrNull: vi.fn(async (id: string) => (id === CONSULTATION ? { id, tenantId: TENANT } : id === 'foreign' ? { id, tenantId: 'tenant-2' } : null)),
  };
  const evaluations = {
    findAll: vi.fn(async (args: { limit?: number }) => rows.slice(0, args.limit ?? rows.length)),
    findByIdOrNull: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    count: vi.fn(async () => 0),
  };
  const notices = { count: vi.fn(async () => 2) };
  const caller = opts.caller ?? 'tenant-admin';
  const user = caller === 'super' ? { id: 'u-super', roles: ['SUPER_ADMIN'] } : caller === 'service-account' ? undefined : { id: `u-${caller}`, roles: [] };
  const roleAssignments = {
    findAll: vi.fn(async () => (caller === 'tenant-admin' ? [{ Roles: [{ name: 'TENANT_ADMIN' }] }] : [{ Roles: [{ name: 'DOCTOR' }] }])),
  };
  const secrets = { decrypt: vi.fn(async () => Buffer.from('the withheld note', 'utf8')) };
  const eventEmitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? user : key === 'serviceAccount' ? (caller === 'service-account' ? { id: 'sa-1' } : undefined) : undefined)),
  };
  const service = new GuardrailEvaluationAdminService(
    consultations as never,
    evaluations as never,
    notices as never,
    eventEmitter as never,
    cls as never,
    roleAssignments as never,
    secrets as never,
  );
  return { service, evaluations, secrets, eventEmitter, notices };
}

describe('GuardrailEvaluationAdminService.list', () => {
  it('pages newest first with a keyset cursor, and carries no content', async () => {
    const h = makeHarness();
    const page = await h.service.list(CONSULTATION, { limit: 2 });
    expect(page.items.map((row) => row.evaluationId)).toEqual(['e-3', 'e-2']);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!)).toEqual({ k: '2026-10-07T09:02:00.000Z', id: 'e-2' });
    expect(page.items[0]).toMatchObject({ direction: 'inbound', decision: 'warn', hasWithheldContent: false, noticeIds: ['n-1'] });
    expect(JSON.stringify(page)).not.toContain('vault:');
    const [args] = h.evaluations.findAll.mock.calls[0] as unknown as [{ where: Record<string, unknown>; sort: unknown }];
    expect(args.sort).toEqual([{ at: 'desc' }, { id: 'desc' }]);
  });

  it('filters by action (decision), direction and check', async () => {
    const h = makeHarness();
    await h.service.list(CONSULTATION, { action: 'block', direction: 'outbound', check: 'leakage_judge' });
    const [args] = h.evaluations.findAll.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where).toMatchObject({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      decision: 'BLOCK',
      direction: 'OUTBOUND',
      checks: { array_contains: [{ checkId: 'leakage_judge' }] },
    });
  });

  it('refuses an unknown filter value (400) and is 404 for another tenant`s consultation', async () => {
    const h = makeHarness();
    await expect(h.service.list(CONSULTATION, { action: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.list('foreign', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes a check`s `reason` (why it was skipped / undetermined) on the row', async () => {
    const row = evaluation('e-r', 5, false, [
      { checkId: 'leakage_judge', verdict: 'skipped', actionTaken: 'none', model: null, latencyMs: 0, regionKeys: [], items: [], reason: 'not_selected_for_tenant' },
    ]);
    const h = makeHarness({ rows: [row] });
    const page = await h.service.list(CONSULTATION, {});
    expect(page.items[0].checks[0]).toMatchObject({ verdict: 'skipped', reason: 'not_selected_for_tenant' });
  });

  it('marks the outbound block that holds withheld content', async () => {
    const h = makeHarness();
    const page = await h.service.list(CONSULTATION, {});
    expect(page.items.find((row) => row.evaluationId === 'e-1')).toMatchObject({ hasWithheldContent: true, decision: 'block' });
  });
});

describe('GuardrailEvaluationAdminService.getWithheld', () => {
  it('decrypts the withheld output for a tenant admin of this tenant, and audits the read', async () => {
    const h = makeHarness({ caller: 'tenant-admin' });
    const result = await h.service.getWithheld(CONSULTATION, 'e-1');
    expect(result).toMatchObject({ evaluationId: 'e-1', consultationId: CONSULTATION, content: 'the withheld note' });
    expect(h.secrets.decrypt).toHaveBeenCalledWith('vault:v2:c2VjcmV0', 'hope-phi');
    const audited = h.eventEmitter.emit.mock.calls.map(([, p]) => p as { forceAuditLog?: boolean; data?: { action?: string } });
    expect(audited.some((p) => p.forceAuditLog && p.data?.action === 'guardrail_withheld_decrypt')).toBe(true);
    expect(JSON.stringify(audited)).not.toContain('the withheld note');
  });

  it('admits a super admin and a service account', async () => {
    await expect(makeHarness({ caller: 'super' }).service.getWithheld(CONSULTATION, 'e-1')).resolves.toMatchObject({ content: 'the withheld note' });
    await expect(makeHarness({ caller: 'service-account' }).service.getWithheld(CONSULTATION, 'e-1')).resolves.toMatchObject({ content: 'the withheld note' });
  });

  it('is 403 for a doctor BEFORE any row is read, whatever the id', async () => {
    const h = makeHarness({ caller: 'doctor' });
    await expect(h.service.getWithheld(CONSULTATION, 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.getWithheld(CONSULTATION, 'no-such-id')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.evaluations.findByIdOrNull).not.toHaveBeenCalled();
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
  });

  it('is 404 for another tenant`s consultation, an unknown evaluation, and one with nothing withheld', async () => {
    const h = makeHarness({ caller: 'tenant-admin' });
    await expect(h.service.getWithheld('foreign', 'e-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.getWithheld(CONSULTATION, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.getWithheld(CONSULTATION, 'e-2')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GuardrailEvaluationAdminService.aggregates', () => {
  it('counts the consultation`s evaluations by decision plus its open notices', async () => {
    const h = makeHarness();
    h.evaluations.count.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { decision?: string } }).where;
      return where.decision === 'WARN' ? 4 : where.decision === 'BLOCK' ? 1 : where.decision === 'UNVERIFIED' ? 2 : 10;
    });
    expect(await h.service.aggregates(TENANT, CONSULTATION)).toEqual({ evaluations: 10, warn: 4, block: 1, unverified: 2, openNotices: 2 });
  });
});
