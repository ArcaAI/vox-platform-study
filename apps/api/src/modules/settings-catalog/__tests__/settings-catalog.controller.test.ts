import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    expect(res.items.some((i) => i.key === 'rateLimit.maxRequests')).toBe(true);
  });

  it('a tenant admin does NOT see global-only entries but keeps tenant-editable ones', () => {
    const res = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 't1' }).getCatalog();
    expect(res.items.some((i) => i.key === 'entitlements.enabled')).toBe(false);
    expect(res.items.every((i) => !i.globalOnly)).toBe(true);
    expect(res.items.some((i) => i.key === 'rateLimit.maxRequests')).toBe(true);
    // Specimen changed twice: `tts.credential.azure` went with the `db-secret` tier (TASK-872),
    // then `tts.defaultVoiceEn` went with the per-tenant tts settings surface (TASK-879 — a
    // tenant's default voice is `Agent.parameters.voice` now). `rateLimit.maxRequests` is one of
    // the SIX keys the configuration-governance program leaves tenant-scoped at its end state, so
    // it is the specimen least likely to need changing again.
    expect(res.items.some((i) => i.key === 'rateLimit.maxRequests')).toBe(true);
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
    const resolveEffective = vi.fn(async () => ({ key: 'harness.loop.emergencyStop', tier: 'global-kv', value: true, sourceScope: 'department' }));
    // super-admin passes ?tenantId= explicitly
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, { resolveEffective });
    const res = await controller.getEffective('harness.loop.emergencyStop', 'tnt-9', 'dep-1');

    expect(res).toEqual({ key: 'harness.loop.emergencyStop', tier: 'global-kv', value: true, sourceScope: 'department' });
    expect(resolveEffective).toHaveBeenCalledWith('harness.loop.emergencyStop', {
      tenantId: 'tnt-9',
      departmentId: 'dep-1',
      doctorId: null,
    });
  });

  it('pins a tenant-bound caller to its CLS tenant (ignores an absent query tenant)', async () => {
    // Specimen is a TENANT-VISIBLE key. `consultation.ocr.enabled` used to stand
    // here and is `globalOnly` + `maxScope: 'system'`, so under TASK-932 R-1 it
    // is now a 404 for this caller — which the case below is what pins.
    const resolveEffective = vi.fn(async () => ({ key: 'rateLimit.maxRequests', tier: 'global-kv', value: 100, sourceScope: 'tenant' }));
    const controller = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' }, { resolveEffective }, 'tnt-self');
    await controller.getEffective('rateLimit.maxRequests');

    expect(resolveEffective).toHaveBeenCalledWith('rateLimit.maxRequests', {
      tenantId: 'tnt-self',
      departmentId: null,
      doctorId: null,
    });
  });

  // ── TASK-932 R-1 / D-5 — the effective read is not a directory ────────────
  it('404s a platform-only key for a tenant admin, and never reaches the resolver', async () => {
    const resolveEffective = vi.fn();
    const controller = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' }, { resolveEffective }, 'tnt-self');

    // `maxScope: 'system'` — no tenant row could ever exist for it.
    await expect(controller.getEffective('consultation.ocr.enabled')).rejects.toBeInstanceOf(NotFoundException);
    // `globalOnly` with a tenant-deep maxScope — the platform decides it.
    await expect(controller.getEffective('console.mlflow.enabled')).rejects.toBeInstanceOf(NotFoundException);
    expect(resolveEffective).not.toHaveBeenCalled();
  });

  it('gives an UNKNOWN key and a platform-only key the same 404, so neither confirms the other', async () => {
    const controller = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' }, {}, 'tnt-self');
    const unknown = await controller.getEffective('no.such.key.at.all').catch((e: Error) => e);
    const hidden = await controller.getEffective('consultation.ocr.enabled').catch((e: Error) => e);
    expect(unknown).toBeInstanceOf(NotFoundException);
    expect(hidden).toBeInstanceOf(NotFoundException);
  });

  it('a super admin still reads a platform-only key', async () => {
    const resolveEffective = vi.fn(async () => ({ key: 'consultation.ocr.enabled', tier: 'global-kv', value: false, sourceScope: 'system' }));
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, { resolveEffective }, 'tnt-working');
    await controller.getEffective('consultation.ocr.enabled');
    expect(resolveEffective).toHaveBeenCalled();
  });

  // ── TASK-932 R-6 — the platform row needs no tenant ───────────────────────
  it('resolves SYSTEM for an elevated caller at scope=system with NO working tenant and NO ?tenantId', async () => {
    const resolveEffective = vi.fn(async () => ({ key: 'rateLimit.maxRequests', tier: 'global-kv', value: 100, sourceScope: 'system' }));
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, { resolveEffective });

    await controller.getEffective('rateLimit.maxRequests', undefined, undefined, undefined, 'system');

    expect(resolveEffective).toHaveBeenCalledWith('rateLimit.maxRequests', {
      tenantId: '00000000-0000-0000-0000-000000000000',
      departmentId: null,
      doctorId: null,
    });
  });

  it('an unscoped elevated caller with no scope resolves SYSTEM rather than being refused 400', async () => {
    const resolveEffective = vi.fn(async () => ({ key: 'rateLimit.maxRequests', tier: 'global-kv', value: 100, sourceScope: 'system' }));
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, { resolveEffective });
    await expect(controller.getEffective('rateLimit.maxRequests')).resolves.toBeTruthy();
    expect(resolveEffective).toHaveBeenCalledWith('rateLimit.maxRequests', expect.objectContaining({ tenantId: '00000000-0000-0000-0000-000000000000' }));
  });

  it('scope=tenant still needs a tenant — a platform row is not a substitute for one', async () => {
    const controller = controllerFor({ roles: ['SUPER_ADMIN'] }, {});
    await expect(controller.getEffective('rateLimit.maxRequests', undefined, undefined, undefined, 'tenant')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ── TASK-932 R-6 / D-6 — the derived lock reaches the wire ──────────────────
describe('SettingsCatalogController.getCatalog — locked keys', () => {
  it('marks bootstrap/credential keys locked with a reason, and leaves a writable key unmarked', () => {
    const res = controllerFor({ roles: ['SUPER_ADMIN'] }).getCatalog();

    const bootstrap = res.items.find((i) => i.tier === 'env');
    expect(bootstrap, 'the catalog must still carry the bootstrap floor for a platform admin').toBeDefined();
    expect(bootstrap!.locked).toBe(true);
    expect(bootstrap!.lockReason).toBeTruthy();
    expect(bootstrap!.lockLabel).toBeTruthy();

    const vaultSecret = res.items.find((i) => i.tier === 'vault-kv');
    expect(vaultSecret!.locked).toBe(true);

    // `db-config` is refused by THIS lane but is genuinely editable elsewhere,
    // so it must NOT claim to be locked — "managed by deployment" would be a lie
    // about a key two clicks away.
    const dbConfig = res.items.find((i) => i.tier === 'db-config');
    expect(dbConfig?.locked).toBeUndefined();

    const writable = res.items.find((i) => i.key === 'rateLimit.maxRequests');
    expect(writable!.locked).toBeUndefined();
    expect(writable!.lockReason).toBeUndefined();
  });

  it('a locked key is locked for a SUPER ADMIN too — the lock is not a privilege gate', () => {
    const asSuper = controllerFor({ roles: ['SUPER_ADMIN'] }).getCatalog();
    expect(asSuper.items.filter((i) => i.locked).length).toBeGreaterThan(0);
    expect(asSuper.items.filter((i) => i.tier === 'env').every((i) => i.locked === true)).toBe(true);
  });
});

// ── TASK-932 R-1 / D-5 — the catalog filter itself ─────────────────────────
describe('SettingsCatalogController.getCatalog — tenant visibility', () => {
  it('hides every platform-only descriptor from a tenant admin (system scope OR globalOnly)', () => {
    const res = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 't1' }).getCatalog();
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      expect(item.globalOnly, `${item.key} is globalOnly and must not be listed`).toBeFalsy();
      expect(item.maxScope, `${item.key} is system-scoped and must not be listed`).not.toBe('system');
    }
    // Named specimens from the families that used to leak wholesale.
    for (const hidden of ['jwt.secretKey', 'database.url', 'consultation.ocr.enabled', 'console.mlflow.enabled', 'harness.claimCheck.enabled']) {
      expect(res.items.some((i) => i.key === hidden), `${hidden} must not reach a tenant admin`).toBe(false);
    }
  });

  it('a tenant admin sees no Bootstrap, Credentials, Platform Operations-only or Service Runtime keys', () => {
    const res = controllerFor({ roles: ['TENANT_ADMIN'], tenantId: 't1' }).getCatalog();
    expect(res.categories).not.toContain('Bootstrap');
    expect(res.categories).not.toContain('Credentials');
    expect(res.categories).not.toContain('Service Runtime');
    expect(res.categories).not.toContain('Feature Availability');
  });
});
