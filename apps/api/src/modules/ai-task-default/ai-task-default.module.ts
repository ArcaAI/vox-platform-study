import { AiModelServiceModule, AiTaskDefaultServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiTaskDefaultAdminController } from './ai-task-default-admin.controller';

/**
 * AiTaskDefaultModule — mounts the `/admin/ai-task-defaults`
 * surface. `AiTaskDefaultService` (tenant→SYSTEM effective resolution + OCC
 * row writes + guardrail super-admin governance) comes from
 * `@arcaai/applications`; `ClsService` resolves from its global module.
 */
@Module({
  imports: [AiTaskDefaultServiceModule, AiModelServiceModule],
  controllers: [AiTaskDefaultAdminController],
})
export class AiTaskDefaultModule {}
