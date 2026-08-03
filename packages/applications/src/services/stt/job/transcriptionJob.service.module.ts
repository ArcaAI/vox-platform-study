import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { BatchTranscriptionLimitsService } from './batch-transcription-limits.service';
import { TranscriptionJobService } from './transcriptionJob.service';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';

@Module({
  // EffectiveSettingsModule backs `BatchTranscriptionLimitsService` — the
  // registry-resolved `stt.batch.*` ceilings the upload route enforces (TASK-604).
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, EntitlementsServiceModule, EffectiveSettingsModule],
  providers: [TranscriptionJobService, BatchTranscriptionLimitsService],
  exports: [TranscriptionJobService, BatchTranscriptionLimitsService],
})
export class TranscriptionJobServiceModule {}
