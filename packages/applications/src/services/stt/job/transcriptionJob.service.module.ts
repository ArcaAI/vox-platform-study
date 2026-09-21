import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { BatchTranscriptionLimitsService } from './batch-transcription-limits.service';
import { TranscriptionJobService } from './transcriptionJob.service';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ProviderCapacityServiceModule } from '../../provider-capacity/provider-capacity.service.module';

@Module({
  // EffectiveSettingsModule backs `BatchTranscriptionLimitsService` — the
  // registry-resolved `stt.batch.*` ceilings the upload route enforces.
  // TASK-998 OD-4 — ProviderCapacityServiceModule backs the per-provider
  // requests-per-minute check on batch submit (the vendor's sync-REST cap).
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, EntitlementsServiceModule, EffectiveSettingsModule, ProviderCapacityServiceModule],
  providers: [TranscriptionJobService, BatchTranscriptionLimitsService],
  exports: [TranscriptionJobService, BatchTranscriptionLimitsService],
})
export class TranscriptionJobServiceModule {}
