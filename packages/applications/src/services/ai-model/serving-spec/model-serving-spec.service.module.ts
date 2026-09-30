import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { IModelServingSpecService } from './IModelServingSpecService';
import { ModelServingSpecService } from './model-serving-spec.service';

/** TASK-1021 — backs the internal `GET /internal/models/:slug/serving-spec` route `apps/vllm` calls. */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule],
  providers: [ModelServingSpecService, { provide: IModelServingSpecService, useExisting: ModelServingSpecService }],
  exports: [IModelServingSpecService],
})
export class ModelServingSpecServiceModule {}
