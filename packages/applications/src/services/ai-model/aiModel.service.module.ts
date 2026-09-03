import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AiModelService } from './aiModel.service';

@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule],
  providers: [AiModelService],
  exports: [AiModelService],
})
export class AiModelServiceModule {}
