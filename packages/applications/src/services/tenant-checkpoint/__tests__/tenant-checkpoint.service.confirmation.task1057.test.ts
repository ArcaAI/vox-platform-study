/**
 * TASK-1057 — the restore reason follows the platform action-confirmation policy (`tenantCheckpoint.restore`,
 * default `required`, 10–1000 characters). Break-glass is LOCKED and is stamped, never switchable.
 */
import { describe, expect, it } from 'vitest';
import { SysEventType } from '@arcaai/domains';
import { buildService, checkpointEntity, TENANT_A } from './service-fixture';

const valid = {
  categories: ['CONFIG_CONTENT'] as ('CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL')[],
  reason: 'rolling back a bad agent rewrite',
  password: 'right-password',
  confirmationName: 'Acme Clinic',
};

function ready(f: ReturnType<typeof buildService>) {
  const row = checkpointEntity();
  f.checkpoints.findByIdOrNull.mockResolvedValue(row);
  return row;
}

const requested = (f: ReturnType<typeof buildService>) =>
  (f.eventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceCreated)?.[1] as { data: Record<string, unknown> }).data;

describe('tenantCheckpoint.restore — reason policy', () => {
  it('default (required): an empty reason keeps today`s 400 RESTORE_REASON_INVALID', async () => {
    const f = buildService();
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, reason: '' })).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESTORE_REASON_INVALID', message: 'A reason of 10-1000 characters is required.' },
    });
  });

  it('default: the audit carries the reason stamp and the locked break-glass stamp', async () => {
    const f = buildService();
    ready(f);
    await f.service.restore(TENANT_A, 'c', valid);
    const data = requested(f);
    expect(data.confirmation).toEqual({
      actionId: 'tenantCheckpoint.restore',
      kind: 'reason',
      mode: 'required',
      locked: false,
      required: true,
      provided: true,
      note: 'reason required',
    });
    expect(data.breakGlassConfirmation).toMatchObject({
      actionId: 'tenantCheckpoint.restoreBreakGlass',
      kind: 'breakGlass',
      locked: true,
      required: true,
      provided: true,
    });
  });

  it('not-required: an empty reason is accepted, stored as the marker, and stamped "reason not required"', async () => {
    const f = buildService(undefined, { confirmationModes: { 'tenantCheckpoint.restore': 'not-required' } });
    ready(f);
    const out = await f.service.restore(TENANT_A, 'c', { ...valid, reason: '' });
    expect(out.reason).toBe('(reason not required)');
    expect(requested(f).confirmation).toMatchObject({ mode: 'not-required', required: false, provided: false, note: 'reason not required' });
  });

  it('not-required: a short reason is accepted as given', async () => {
    const f = buildService(undefined, { confirmationModes: { 'tenantCheckpoint.restore': 'not-required' } });
    ready(f);
    const out = await f.service.restore(TENANT_A, 'c', { ...valid, reason: 'oops' });
    expect(out.reason).toBe('oops');
  });

  it('not-required: an over-long reason is still refused', async () => {
    const f = buildService(undefined, { confirmationModes: { 'tenantCheckpoint.restore': 'not-required' } });
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, reason: 'x'.repeat(1001) })).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESTORE_REASON_INVALID' },
    });
  });

  it('not-required never lifts break-glass (locked)', async () => {
    const f = buildService(undefined, { confirmationModes: { 'tenantCheckpoint.restore': 'not-required' } });
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, reason: '', password: undefined })).rejects.toMatchObject({ status: 428 });
  });
});
