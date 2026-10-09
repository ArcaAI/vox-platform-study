/**
 * TASK-1057 lane A — the platform read/write plane of ActionConfirmationService
 * (modelled on FeatureAvailabilityService.readMatrix/applyMatrix).
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ACTION_CONFIRMATION_CATALOGUE } from '@arcaai/types';
import { ActionConfirmationService } from '../action-confirmation.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const superAdmin = { roles: ['SUPER_ADMIN'] };
const tenantAdmin = { roles: ['TENANT_ADMIN'], tenantId: 'tnt-1' };

function makeService(user: unknown, rows: Array<{ key: string; tenantId: string; value: unknown; version: number }> = []) {
  const store = [...rows];
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? user : undefined)),
    set: vi.fn(),
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
  const write = vi.fn(async (key: string, value: unknown) => {
    const existing = store.find((r) => r.key === key);
    if (existing) {
      existing.value = value;
      existing.version += 1;
    } else store.push({ key, tenantId: SYSTEM, value, version: 1 });
    return {} as never;
  });
  const repo = { findAll: vi.fn(async () => store.map((r) => ({ ...r, parsedValue: r.value }))) };
  const tenantSettings = { resolve: vi.fn((key: string) => ({ value: store.find((r) => r.key === key)?.value, source: 'system' })) };
  const service = new ActionConfirmationService(tenantSettings as never, cls as never, { write } as never, repo as never);
  return { service, write, store };
}

describe('readPlatform', () => {
  it('is super-admin only (403)', async () => {
    const { service } = makeService(tenantAdmin);
    await expect(service.readPlatform()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns every catalogue row with source and fresh version', async () => {
    const { service } = makeService(superAdmin, [{ key: 'confirmation.promptTemplate.update', tenantId: SYSTEM, value: 'required', version: 4 }]);
    const rows = await service.readPlatform();
    expect(rows).toHaveLength(ACTION_CONFIRMATION_CATALOGUE.length);
    const set = rows.find((r) => r.actionId === 'promptTemplate.update')!;
    expect(set).toMatchObject({ mode: 'required', source: 'system', version: 4 });
    const locked = rows.find((r) => r.locked)!;
    expect(locked).toMatchObject({ mode: 'required', source: 'locked', version: 0 });
    const untouched = rows.find((r) => !r.locked && r.actionId !== 'promptTemplate.update')!;
    expect(untouched).toMatchObject({ source: 'default', version: 0 });
  });
});

describe('applyPlatform', () => {
  it('is super-admin only (403)', async () => {
    const { service } = makeService(tenantAdmin);
    await expect(service.applyPlatform([{ actionId: 'promptTemplate.update', mode: 'required' }])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes through the governed lane at system scope with the expected version', async () => {
    const { service, write } = makeService(superAdmin);
    const result = await service.applyPlatform([{ actionId: 'promptTemplate.update', mode: 'required', expectedVersion: 2 }]);
    expect(write).toHaveBeenCalledWith('confirmation.promptTemplate.update', 'required', { scope: 'system', expectedVersion: 2 });
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ actionId: 'promptTemplate.update', mode: 'required' });
  });

  it('rejects unknown, locked and disallowed modes per cell without aborting the batch', async () => {
    const { service, write } = makeService(superAdmin);
    const locked = ACTION_CONFIRMATION_CATALOGUE.find((s) => s.locked)!;
    const noRisky = ACTION_CONFIRMATION_CATALOGUE.find((s) => !s.locked && !s.modes.includes('when-risky'))!;
    const result = await service.applyPlatform([
      { actionId: 'nope.nothing', mode: 'required' },
      { actionId: locked.actionId, mode: 'not-required' },
      { actionId: noRisky.actionId, mode: 'when-risky' },
      { actionId: 'promptTemplate.update', mode: 'required' },
    ]);
    expect(result.errors.map((e) => e.status)).toEqual([400, 400, 400]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.rows.map((r) => r.actionId)).toEqual(['promptTemplate.update']);
  });

  it('null resets to the catalogue default and is idempotent when already there', async () => {
    const { service, write } = makeService(superAdmin, [{ key: 'confirmation.promptTemplate.update', tenantId: SYSTEM, value: 'required', version: 2 }]);
    await service.applyPlatform([{ actionId: 'promptTemplate.update', mode: null }]);
    expect(write).toHaveBeenCalledWith('confirmation.promptTemplate.update', 'not-required', { scope: 'system' });
    write.mockClear();
    const again = await service.applyPlatform([{ actionId: 'promptTemplate.update', mode: null }]);
    expect(write).not.toHaveBeenCalled();
    expect(again.errors).toEqual([]);
  });

  it('reports a write-lane failure as a per-cell error with its status', async () => {
    const { service, write } = makeService(superAdmin);
    write.mockRejectedValueOnce(Object.assign(new Error('drift'), { getStatus: () => 412 }));
    const result = await service.applyPlatform([{ actionId: 'promptTemplate.update', mode: 'required', expectedVersion: 1 }]);
    expect(result.errors).toEqual([{ actionId: 'promptTemplate.update', status: 412, message: 'drift' }]);
  });
});
