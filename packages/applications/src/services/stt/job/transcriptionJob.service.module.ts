import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { TranscriptionJobService } from './transcriptionJob.service';

@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule],
  providers: [TranscriptionJobService],
  exports: [TranscriptionJobService],
})
export class TranscriptionJobServiceModule {}
