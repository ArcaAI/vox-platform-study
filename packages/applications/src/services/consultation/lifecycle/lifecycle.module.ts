import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { RedisCacheModule } from '../../baseServices/redis';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingSessionServiceModule } from '../../stt/streaming/streamingSession.service.module';
import { ConsultationEncounterServiceModule } from '../encounter/consultation-encounter.service.module';
import { ConsultationApprovalService } from './consultation-approval.service';
import { ConsultationLifecycleGate } from './consultation-lifecycle.gate';
import { ConsultationLifecycleService } from './consultation-lifecycle.service';
import { IConsultationLifecycleGateToken, IConsultationLifecycleServiceToken } from './IConsultationLifecycleService';
import { ConsultationLifecycleEventPublisher } from './lifecycle-event.publisher';
import { LazySessionNoteSigner } from './lazy-session-note-signer';
import { SESSION_NOTE_SIGNER } from './session-note-signer';
import { TranscriptRecordServiceModule } from '../transcript-record/transcript-record.service.module';

/**
 * The lifecycle GATE on its own (content lock, activity clock, processing axis) plus the event
 * publisher. It depends on nothing consultation-specific, so any service that must respect the
 * lifecycle — summaries, document sections, context, attachments, the harness callers — imports
 * THIS module without a cycle.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, RedisCacheModule.register()],
  providers: [
    RedisSubscriberService,
    ConsultationLifecycleEventPublisher,
    ConsultationLifecycleGate,
    { provide: IConsultationLifecycleGateToken, useExisting: ConsultationLifecycleGate },
  ],
  exports: [IConsultationLifecycleGateToken, ConsultationLifecycleGate, ConsultationLifecycleEventPublisher],
})
export class ConsultationLifecycleGateModule {}

/**
 * The lifecycle commands (`IConsultationLifecycleServiceToken`) and, re-exported, the gate
 * (`IConsultationLifecycleGateToken`). The note-signing core in `SummaryService` is reached
 * lazily (`LazySessionNoteSigner`), and `SummaryService` reaches the command service back the same
 * way, so neither module imports the other.
 *
 * `ITranscriptRecordServiceToken` is injected optionally: the module that provides it is wired
 * beside this one by the app (unwired ⇒ `stop` answers `pending` and the record service
 * completes it).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConsultationLifecycleGateModule,
    // `stop` waits for the final transcript of the last bytes.
    TranscriptRecordServiceModule,
    HarnessAuditServiceModule,
    EffectiveSettingsModule,
    StreamingSessionServiceModule,
    // The episode view for responses. NOT ConsultationServiceModule: that one injects the
    // lifecycle token, so importing it here would be a cycle.
    ConsultationEncounterServiceModule,
  ],
  providers: [
    ConsultationApprovalService,
    ConsultationLifecycleService,
    LazySessionNoteSigner,
    { provide: SESSION_NOTE_SIGNER, useExisting: LazySessionNoteSigner },
    { provide: IConsultationLifecycleServiceToken, useExisting: ConsultationLifecycleService },
  ],
  exports: [IConsultationLifecycleServiceToken, ConsultationLifecycleService, ConsultationLifecycleGateModule],
})
export class ConsultationLifecycleModule {}
