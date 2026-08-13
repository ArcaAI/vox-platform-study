import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { ITenantAllowedOriginService, UnifiedAuthGuard } from '@arcaai/applications';
import { auditAdminRoutePermissions } from '../../../bootstrap/admin-route-permission-audit';
import { TenantAllowedOriginController } from '../tenant-allowed-origin.controller';

/**
 * The blanket `assertGlobalAdmin` call is gone from every
 * handler, including the new `GET admin/allowed-origins/posture` route. The
 * boot-time deny-by-default audit (`admin-route-permission-audit.ts`) is what
 * would refuse to start the app if any `/admin/*` route were left without a
 * concrete permission decorator — this pins that the class-level
 * `@CanManage('TenantAllowedOrigin')` alone still satisfies it for all six
 * routes on this controller (mirrors the synthetic `AdminUsersOk` case in
 * `admin-route-permission-audit.test.ts`, run here against the real class).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor param types vary per controller under test; mirrors the NestJS `Type<any>` shape.
async function buildAppFromControllers(controllers: Array<new (...args: any[]) => unknown>) {
  @Module({
    controllers,
    providers: [{ provide: ITenantAllowedOriginService, useValue: {} }],
  })
  class _SyntheticModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [_SyntheticModule],
  })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditAdminRoutePermissions>[0];
}

describe('TenantAllowedOriginController — boot-time deny-by-default route audit', () => {
  it('passes for all six routes (five CRUD + posture) via the class-level @CanManage alone', async () => {
    const app = await buildAppFromControllers([TenantAllowedOriginController]);
    expect(() => auditAdminRoutePermissions(app)).not.toThrow();
  });
});
