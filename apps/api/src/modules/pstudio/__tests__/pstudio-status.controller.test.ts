import { describe, it, expect, afterEach } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { PrismaStudioStatusController } from '../pstudio-status.controller';

// TASK-403 — the Studio module itself is conditionally registered (dev-only),
// which makes its availability unobservable from the admin console (404 vs
// disabled are indistinguishable). This always-registered status endpoint
// reports the same env decision (`shouldEnablePrismaStudio`) so the FE card
// can render a truthful enabled/disabled state in every environment.
describe('PrismaStudioStatusController (TASK-403)', () => {
  const controller = new PrismaStudioStatusController();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_PRISMA_STUDIO;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) {
      delete process.env.ENABLE_PRISMA_STUDIO;
    } else {
      process.env.ENABLE_PRISMA_STUDIO = originalFlag;
    }
  });

  it('reports enabled when both dev signals are set', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_PRISMA_STUDIO = 'true';

    expect(controller.getStatus()).toEqual({ enabled: true });
  });

  it('reports disabled outside development even if the flag is set', () => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_PRISMA_STUDIO = 'true';

    expect(controller.getStatus()).toEqual({ enabled: false });
  });

  it('reports disabled in development when the flag is off', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_PRISMA_STUDIO = 'false';

    expect(controller.getStatus()).toEqual({ enabled: false });
  });

  it('is class-gated by @Authorize(["manage","all"]) (SUPER_ADMIN only)', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PrismaStudioStatusController) as
      | Array<{ action: string; subject: string }>
      | undefined;
    expect(meta).toEqual([{ action: 'manage', subject: 'all' }]);
  });
});
