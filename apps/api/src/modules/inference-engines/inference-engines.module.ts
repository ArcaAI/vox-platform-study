import { InferenceEngineServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { InferenceEnginesController } from './inference-engines.controller';

/** TASK-996 Phase 3 — `/admin/inference-engines/lm-studio/*`. */
@Module({
  imports: [InferenceEngineServiceModule],
  controllers: [InferenceEnginesController],
})
export class InferenceEnginesModule {}
