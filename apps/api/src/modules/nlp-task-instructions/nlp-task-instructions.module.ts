import { Module } from '@nestjs/common';
import { TenantNlpTaskInstructionsServiceModule } from '@arcaai/applications';
import { NlpTaskInstructionsAdminController } from './nlp-task-instructions-admin.controller';

/**
 * NlpTaskInstructionsModule — mounts the `/admin/nlp-task-instructions`
 * surface. `TenantNlpTaskInstructionsService` (OCC row CRUD for
 * nlp.topic/nlp.intent instruction content) comes from `@arcaai/applications`;
 * `ClsService` resolves from its global module.
 */
@Module({
  imports: [TenantNlpTaskInstructionsServiceModule],
  controllers: [NlpTaskInstructionsAdminController],
})
export class NlpTaskInstructionsModule {}
