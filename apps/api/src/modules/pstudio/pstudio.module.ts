import { PrismaStudioServiceModule, AuditLogServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { PrismaStudioController } from './pstudio.controller';

/**
 * Prisma Studio
 * is production-capable but FAIL-CLOSED — the module registers only when the
 * operator explicitly sets `ENABLE_PRISMA_STUDIO=true`, and every route is
 * additionally pinned to the dedicated `manage:PrismaStudio` CASL subject
 * (seeded to the GLOBAL_ADMIN policy set). An unset/false flag keeps the
 * studio entirely off, so it can never accidentally surface on a
 * misconfigured host.
 */
export function shouldEnablePrismaStudio(env: { NODE_ENV?: string; ENABLE_PRISMA_STUDIO?: string }): boolean {
  return env.ENABLE_PRISMA_STUDIO === 'true';
}

@Module({
  // AuditLogServiceModule provides IAuditLogService so the BFF
  // controller can audit every raw Studio query/sequence (it is not @Global).
  imports: [PrismaStudioServiceModule, AuditLogServiceModule],
  controllers: [PrismaStudioController],
})
export class PrismaStudioModule {}
