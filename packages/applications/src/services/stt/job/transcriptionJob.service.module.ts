import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { TranscriptionJobService } from './transcriptionJob.service';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';

@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, EntitlementsServiceModule],
  providers: [TranscriptionJobService],
  exports: [TranscriptionJobService],
})
export class TranscriptionJobServiceModule {}
