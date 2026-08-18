import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA } from '@nestjs/common/constants';

/**
 * Reduced after module removal — only tests controllers that remain in the API.
 */

const MODULES = join(__dirname, '..', 'modules');

function readController(relativePath: string): string {
  return readFileSync(join(MODULES, relativePath), 'utf-8');
}

function extractControllerPath(source: string): string | null {
  const match = source.match(/@Controller\(\s*['"](.+?)['"]\s*\)/);
  return match ? match[1] : null;
}

// ─── Admin Routes ─────────────────────────────────────────────────────────

describe('Admin route renames', () => {
  const cases: [string, string, string][] = [
    ['tenant/tenant.controller.ts', 'admin/tenants', 'tenants'],
    ['api-key/api-key.controller.ts', 'admin/api-keys', 'api-keys'],
    ['audit-log/audit-log.controller.ts', 'admin/audit-logs', 'audit-logs'],
    ['rbac/roles.controller.ts', 'admin/rbac/roles', 'rbac/roles'],
    ['rbac/policies.controller.ts', 'admin/rbac/policies', 'rbac/policies'],
    ['pstudio/pstudio.controller.ts', 'admin/pstudio', 'pstudio'],
  ];

  it.each(cases)('%s should use @Controller("%s")', (file, expectedPath) => {
    const source = readController(file);
    const actual = extractControllerPath(source);
    expect(actual).toBe(expectedPath);
  });

  it.each(cases)('%s should NOT contain old path "%s"', (file, _expectedPath, oldPath) => {
    const source = readController(file);
    expect(source).not.toMatch(new RegExp(`@Controller\\(\\s*['"]${oldPath.replace(/\//g, '\\/')}['"]\\s*\\)`));
  });
});

// ─── Full Route Resolution ────────────────────────────────────────────────

describe('Full route resolution with api/v1 prefix', () => {
  const globalPrefix = 'api/v1';

  const allRoutes: [string, string, string][] = [
    ['tenant/tenant.controller.ts', 'admin/tenants', '/api/v1/admin/tenants'],
    ['api-key/api-key.controller.ts', 'admin/api-keys', '/api/v1/admin/api-keys'],
    ['audit-log/audit-log.controller.ts', 'admin/audit-logs', '/api/v1/admin/audit-logs'],
    ['rbac/roles.controller.ts', 'admin/rbac/roles', '/api/v1/admin/rbac/roles'],
    ['rbac/policies.controller.ts', 'admin/rbac/policies', '/api/v1/admin/rbac/policies'],
    ['pstudio/pstudio.controller.ts', 'admin/pstudio', '/api/v1/admin/pstudio'],
  ];

  it.each(allRoutes)('%s with path "%s" resolves to %s', (file, expectedPath, expectedFullUrl) => {
    const source = readController(file);
    const actual = extractControllerPath(source);
    expect(actual).toBe(expectedPath);
    expect(`/${globalPrefix}/${actual}`).toBe(expectedFullUrl);
  });

  it('no controller should produce a double api/v1 prefix', () => {
    for (const [file] of allRoutes) {
      const source = readController(file);
      const path = extractControllerPath(source);
      expect(path).not.toBeNull();
      const fullUrl = `/${globalPrefix}/${path}`;
      expect(fullUrl).not.toContain('/api/v1/api/v1/');
    }
  });
});

// ─── @ApiTags Alignment ───────────────────────────────────────────────────

describe('@ApiTags alignment with new routes', () => {
  const tagChecks: [string, string][] = [
    ['tenant/tenant.controller.ts', 'admin-tenants'],
    ['api-key/api-key.controller.ts', 'admin-api-keys'],
    ['audit-log/audit-log.controller.ts', 'admin-audit-logs'],
    ['pstudio/pstudio.controller.ts', 'admin-pstudio'],
  ];

  it.each(tagChecks)('%s should have @ApiTags("%s")', (file, expectedTag) => {
    const source = readController(file);
    const match = source.match(/@ApiTags\(\s*['"](.+?)['"]\s*\)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expectedTag);
  });
});

// ─── Unchanged Controllers ────────────────────────────────────────────────

describe('Unchanged controller paths (no rename needed)', () => {
  const unchanged: [string, string][] = [
    ['auth/auth.controller.ts', 'auth'],
    // `health` stays put — it is the PUBLIC k8s-probe prefix. TASK-759 moved
    // only the two CASL-gated `/services` routes off it, into
    // `AdminHealthServicesController` (asserted below).
    ['health/health.controller.ts', 'health'],
    ['rbac/permission-check.controller.ts', 'rbac/check'],
    ['storage/storage.controller.ts', 'storage'],
  ];

  it.each(unchanged)('%s should still use @Controller("%s")', (file, expectedPath) => {
    const source = readController(file);
    const actual = extractControllerPath(source);
    expect(actual).toBe(expectedPath);
  });
});

// ─── Runtime @Controller metadata ─────────────────────────────────────────

describe('Runtime @Controller metadata (Reflect.getMetadata)', () => {
  const controllerImports: [string, string, () => Promise<any>][] = [
    ['TenantController', 'admin/tenants', () => import('../modules/tenant/tenant.controller').then((m) => m.TenantController)],
    ['ApiKeyController', 'admin/api-keys', () => import('../modules/api-key/api-key.controller').then((m) => m.ApiKeyController)],
    ['AuditLogController', 'admin/audit-logs', () => import('../modules/audit-log/audit-log.controller').then((m) => m.AuditLogController)],
    ['RolesController', 'admin/rbac/roles', () => import('../modules/rbac/roles.controller').then((m) => m.RolesController)],
    ['PoliciesController', 'admin/rbac/policies', () => import('../modules/rbac/policies.controller').then((m) => m.PoliciesController)],
    ['PrismaStudioController', 'admin/pstudio', () => import('../modules/pstudio/pstudio.controller').then((m) => m.PrismaStudioController)],
  ];

  it.each(controllerImports)('%s should have PATH_METADATA = "%s"', async (_name, expectedPath, importFn) => {
    const Controller = await importFn();
    const path = Reflect.getMetadata(PATH_METADATA, Controller);
    expect(path).toBe(expectedPath);
  });
});

// ─── Pstudio Auth Decorators ─────────────────────────────────────────────
//
// Both verbs require an @Authorize guard and the JWT must arrive via the
// Authorization: Bearer header — no @Public() exemption, no ?token= query
// param. The guard is scoped to the dedicated manage:PrismaStudio subject
// (not manage:all).

describe('Pstudio auth decorators', () => {
  it('serveStudio NO LONGER carries @Public() metadata', async () => {
    const { PrismaStudioController } = await import('../modules/pstudio/pstudio.controller');
    const isPublic = Reflect.getMetadata('skip_auth', PrismaStudioController.prototype.serveStudio);
    expect(isPublic).toBeFalsy();
  });

  it('handleStudioRequest should have @Authorize decorator (manage:PrismaStudio)', () => {
    const source = readController('pstudio/pstudio.controller.ts');
    expect(source).toMatch(/@Authorize\(\['manage',\s*'PrismaStudio'\]\)/);
  });
});

// ─── Pstudio Hardcoded URL Regression Guards (retuned by W5.2) ──────────

describe('Pstudio hardcoded URL regression guards', () => {
  // The controller no longer constructs ANY absolute studio
  // endpoint (the Host-derived URL bypassed the console BFF proxy → empty
  // bearer → 401). The shell posts back to window.location.pathname instead.
  it('does not construct a Host-derived studioEndpointUrl at all', () => {
    const source = readController('pstudio/pstudio.controller.ts');
    expect(source).not.toContain('studioEndpointUrl');
    expect(source).not.toMatch(/\$\{protocol\}:\/\/\$\{host\}/);
  });

  it('should NOT reference old /api/pstudio in usage message', () => {
    const source = readController('pstudio/pstudio.controller.ts');
    expect(source).not.toMatch(/Usage:.*\/api\/pstudio\?token=/);
  });

  it('should NOT construct studioEndpointUrl with old /api/pstudio', () => {
    const source = readController('pstudio/pstudio.controller.ts');
    expect(source).not.toMatch(/`\$\{protocol\}:\/\/\$\{host\}\/api\/pstudio`/);
  });

  it('post-W5.2 — should NOT carry `?token=` query parameter (URL-token form removed)', () => {
    const source = readController('pstudio/pstudio.controller.ts');
    expect(source).not.toContain('/api/v1/admin/pstudio?token=');
  });
});

// ─── Complete Controller Inventory ───────────────────────────────────────

describe('Complete controller inventory', () => {
  const allControllers: [string, string][] = [
    ['tenant/tenant.controller.ts', 'admin/tenants'],
    ['api-key/api-key.controller.ts', 'admin/api-keys'],
    ['audit-log/audit-log.controller.ts', 'admin/audit-logs'],
    ['rbac/roles.controller.ts', 'admin/rbac/roles'],
    ['rbac/policies.controller.ts', 'admin/rbac/policies'],
    ['pstudio/pstudio.controller.ts', 'admin/pstudio'],
    ['auth/auth.controller.ts', 'auth'],
    ['health/health.controller.ts', 'health'],
    // TASK-759 (rule P2) — administrative capabilities moved onto the admin
    // plane. HARD MOVE: the pre-move prefixes are gone, not aliased.
    ['monitoring/monitoring.controller.ts', 'admin/monitoring'],
    ['health/admin-health-services.controller.ts', 'admin/health/services'],
    ['rbac/permission-check.controller.ts', 'rbac/check'],
    ['storage/storage.controller.ts', 'storage'],
  ];

  it.each(allControllers)('%s has @Controller("%s")', (file, expectedPath) => {
    const source = readController(file);
    const actual = extractControllerPath(source);
    expect(actual).toBe(expectedPath);
  });

  it('no controller path should start with a leading slash', () => {
    for (const [file] of allControllers) {
      const source = readController(file);
      const path = extractControllerPath(source);
      expect(path).not.toBeNull();
      expect(path!.startsWith('/')).toBe(false);
    }
  });

  it('no controller path should end with a trailing slash', () => {
    for (const [file] of allControllers) {
      const source = readController(file);
      const path = extractControllerPath(source);
      expect(path).not.toBeNull();
      expect(path!.endsWith('/')).toBe(false);
    }
  });

  it('no controller path should contain double slashes', () => {
    for (const [file] of allControllers) {
      const source = readController(file);
      const path = extractControllerPath(source);
      expect(path).not.toBeNull();
      expect(path).not.toContain('//');
    }
  });
});
