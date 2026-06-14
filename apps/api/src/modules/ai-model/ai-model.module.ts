import { AiModelServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiModelAdminController } from './ai-model-admin.controller';

/**
 * TASK-356 Phase 1 (Catalog plane) — wires the admin AI model controller to the
 * already-existing `AiModelService`. Mirrors `PipelineModule`.
 */
@Module({
  imports: [AiModelServiceModule],
  controllers: [AiModelAdminController],
})
export class AiModelModule {}
