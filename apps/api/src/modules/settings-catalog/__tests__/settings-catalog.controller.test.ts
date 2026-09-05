import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService } from '@arcaai/applications';
import { SettingsCatalogController } from '../settings-catalog.controller';

// The catalog serves registry metadata, RBAC-filtered:
// tenant admins never see SUPER_ADMIN-only entries; nothing leaks a value.

function controllerFor(user: unknown, effective: Partial<EffectiveSettingsService> = {}, clsTenantId?: string): SettingsCatalogController {
  const cls = {
    get: (key: string) => (key === 'user' ? user : key === 'tenantId' ? clsTenantId : undefined),
  } as never;
  return new SettingsCatalogController(cls, effective as EffectiveSettingsService);
}

describe('SettingsCatalogController.getCatalog', () => {
  it('a super-admin sees SUPER_ADMIN-only entries (the entitlements kill-switch)', () => {
    const res = controllerFor({ roles: ['SUPER_ADMIN'] }).getCatalog();
    expect(res.items.some((i) => i.key === 'entitlements.enabled')).toBe(true);
    expect(res.items.some((i) => i.key === 'pipeline.autoSummaryEnabled')).toBe(true);
  });

  it('a tenant admin does NOT see global-only entries but keeps tenant-editable ones', () => {
    const res = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 't1' }).getCatalog();
    expect(res.items.some((i) => i.key === 'entitlements.enabled')).toBe(false);
    expect(res.items.every((i) => !i.globalOnly)).toBe(true);
    expect(res.items.some((i) => i.key === 'pipeline.autoSummaryEnabled')).toBe(true);
    // Specimen changed in TASK-872: `tts.credential.azure` was removed with the
    // rest of the `db-secret` tier. `tts.defaultVoiceEn` is the same shape for
    // this assertion — tenant-editable, not `globalOnly`.
    expect(res.items.some((i) => i.key === 'tts.defaultVoiceEn')).toBe(true);
  });

  it('categories are distinct and sorted', () => {
    const res = controllerFor({ roles: ['SUPER_ADMIN'] }).getCatalog();
    expect(res.categories).toEqual([...new Set(res.categories)].sort());
    expect(res.categories.length).toBeGreaterThan(0);
  });

  it('returns metadata only — never a value field', () => {
    const res = controllerFor({ roles: ['SUPER_ADMIN'] }).getCatalog();
    for (const item of res.items) {
      expect('value' in item).toBe(false);
      expect(item.key).toBeTruthy();
      expect(item.category).toBeTruthy();
    }
  });
});

describe('SettingsCatalogController.getEffective', () => {
  it('requires the `key` query param', async () => {
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] });
    await expect(controller.getEffective('' as unknown as string)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves the scoped tenant and delegates to EffectiveSettingsService', async () => {
    const resolveEffective = vi.fn(async () => ({ key: 'pipeline.harnessEnabled', tier: 'db-config', value: true, sourceScope: 'department' }));
    // super-admin passes ?tenantId= explicitly
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, { resolveEffective });
    const res = await controller.getEffective('pipeline.harnessEnabled', 'tnt-9', 'dep-1');

    expect(res).toEqual({ key: 'pipeline.harnessEnabled', tier: 'db-config', value: true, sourceScope: 'department' });
    expect(resolveEffective).toHaveBeenCalledWith('pipeline.harnessEnabled', {
      tenantId: 'tnt-9',
      departmentId: 'dep-1',
      doctorId: null,
    });
  });

  it('pins a tenant-bound caller to its CLS tenant (ignores an absent query tenant)', async () => {
    const resolveEffective = vi.fn(async () => ({ key: 'pipeline.autoNerEnabled', tier: 'db-config', value: false, sourceScope: 'tenant' }));
    const controller = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' }, { resolveEffective }, 'tnt-self');
    await controller.getEffective('pipeline.autoNerEnabled');

    expect(resolveEffective).toHaveBeenCalledWith('pipeline.autoNerEnabled', {
      tenantId: 'tnt-self',
      departmentId: null,
      doctorId: null,
    });
  });
});
