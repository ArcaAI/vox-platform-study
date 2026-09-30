import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices/common.service.module';
import { AiModelServiceModule } from '../aiModel.service.module';
import { ModelPathRegistrationService } from './model-path-registration.service';

/**
 * Registration from a path already in the models bucket (TASK-1023 R4c).
 *
 * Its own module so the registry's main module is untouched: `AiModelServiceModule` supplies
 * `AiModelService` (the one create path), `CoreDatabaseModule` the repository, and
 * `CommonServiceModule` the `IS3Service` the bucket is listed and read through — the same
 * read-capable client the inventory uses; nothing here writes to the bucket.
 * No cycle: none of those imports this module.
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, CommonServiceModule, AiModelServiceModule],
  providers: [ModelPathRegistrationService],
  exports: [ModelPathRegistrationService],
})
export class ModelPathRegistrationServiceModule {}
