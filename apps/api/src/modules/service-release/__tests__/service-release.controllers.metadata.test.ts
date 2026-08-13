/**
 * Metadata/gate assertions for the service-release controllers.
 *
 * - internal routes carry `@Public()` (skip user-auth chain) + the
 *   `ServiceReleaseTokenGuard` class-level guard (service-token auth).
 * - admin routes require EITHER `manage all` OR `read TenantTelemetry` —
 *   the same posture as the existing `/health/services` route.
 *
 * @vitest-environment node
 */
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { describe, expect, it } from 'vitest';
import { ServiceReleaseInternalController } from '../service-release-internal.controller';
import { ServiceReleaseAdminController } from '../service-release-admin.controller';
import { ServiceReleaseTokenGuard } from '../service-release-token.guard';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PERMISSION_MODE_KEY = 'permission_mode';
const GUARDS_KEY = '__guards__';

describe('ServiceReleaseInternalController gates', () => {
  it('is marked @Public() (service-token auth, not the user-JWT chain)', () => {
    expect(Reflect.getMetadata(SKIP_AUTH_KEY, ServiceReleaseInternalController)).toBe(true);
  });

  it('carries the ServiceReleaseTokenGuard at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_KEY, ServiceReleaseInternalController) ?? [];
    expect(guards).toContain(ServiceReleaseTokenGuard);
  });

  it('declares no end-user permission requirement on register() or attachDigest()', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ServiceReleaseInternalController.prototype.register)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ServiceReleaseInternalController.prototype.attachDigest)).toBeUndefined();
  });
});

describe('ServiceReleaseAdminController gates', () => {
  it('requires EITHER `manage all` OR `read TenantTelemetry` at the class level (same posture as /health/services)', () => {
    const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ServiceReleaseAdminController);
    const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, ServiceReleaseAdminController);
    expect(required).toEqual([
      { action: 'manage', subject: 'all' },
      { action: 'read', subject: 'TenantTelemetry' },
    ]);
    expect(mode).toBe('OR');
  });

  it('is not marked @Public()', () => {
    expect(Reflect.getMetadata(SKIP_AUTH_KEY, ServiceReleaseAdminController)).toBeUndefined();
  });
});
