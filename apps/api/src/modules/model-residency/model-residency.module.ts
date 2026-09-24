import { ModelResidencyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { ModelResidencyController } from './model-residency.controller';

/** TASK-1005 — `/admin/model-residency/*`, the platform-admin surface of the ModelResidencyController. */
@Module({
  imports: [ModelResidencyServiceModule],
  controllers: [ModelResidencyController],
})
export class ModelResidencyModule {}
