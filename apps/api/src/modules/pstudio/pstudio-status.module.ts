import { Module } from '@nestjs/common';
import { PrismaStudioStatusController } from './pstudio-status.controller';

/**
 * Registered unconditionally (unlike `PrismaStudioModule`) so the
 * admin console can always ask whether the dev-only Studio shell is enabled.
 */
@Module({
  controllers: [PrismaStudioStatusController],
})
export class PrismaStudioStatusModule {}
