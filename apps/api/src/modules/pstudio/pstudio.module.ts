import { PrismaStudioServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { PrismaStudioController } from './pstudio.controller';

/**
 * TASK-307 W5.2 (AC-16, audit C-9): Prisma Studio is a privileged
 * database browser that must remain entirely off in any non-development
 * environment. Both signals are required so a misconfigured staging /
 * preview host cannot accidentally enable it.
 */
export function shouldEnablePrismaStudio(env: {
  NODE_ENV?: string;
  ENABLE_PRISMA_STUDIO?: string;
}): boolean {
  return env.NODE_ENV === 'development' && env.ENABLE_PRISMA_STUDIO === 'true';
}

@Module({
  imports: [PrismaStudioServiceModule],
  controllers: [PrismaStudioController],
})
export class PrismaStudioModule {}
