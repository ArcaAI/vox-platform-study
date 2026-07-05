import { describe, it, expect, afterEach } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { PrismaStudioStatusController } from '../pstudio-status.controller';

// TASK-403 — the Studio module itself is conditionally registered, which makes
// its availability unobservable from the admin console (404 vs disabled are
// indistinguishable). This always-registered status endpoint reports the same
// env decision (`shouldEnablePrismaStudio`) so the FE card can render a
// truthful enabled/disabled state in every environment.
//
// TASK-419 item 4 — the gate is now production-capable: `ENABLE_PRISMA_STUDIO`
// is the ONLY env signal (fail-closed when unset), and access requires the
// dedicated `manage:PrismaStudio` permission instead of `manage:all`.
describe('PrismaStudioStatusController (TASK-403 / TASK-419)', () => {
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

  it('reports enabled when the flag is set in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_PRISMA_STUDIO = 'true';

    expect(controller.getStatus()).toEqual({ enabled: true });
  });

  it('reports enabled outside development when the flag is set (production-capable, TASK-419)', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_PRISMA_STUDIO = 'true';

    expect(controller.getStatus()).toEqual({ enabled: true });
  });

  it('reports disabled when the flag is off (fail-closed)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_PRISMA_STUDIO = 'false';

    expect(controller.getStatus()).toEqual({ enabled: false });
  });

  it('reports disabled when the flag is absent (fail-closed default)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENABLE_PRISMA_STUDIO;

    expect(controller.getStatus()).toEqual({ enabled: false });
  });

  it('is class-gated by @Authorize(["manage","PrismaStudio"]) (dedicated subject, TASK-419)', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PrismaStudioStatusController) as
      | Array<{ action: string; subject: string }>
      | undefined;
    expect(meta).toEqual([{ action: 'manage', subject: 'PrismaStudio' }]);
  });
});
