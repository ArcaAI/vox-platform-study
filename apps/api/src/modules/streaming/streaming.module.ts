import {
  PipelineServiceModule,
  StreamingSessionServiceModule,
  TenantBucketServiceModule,
  TenantServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TenantOwnedResourceModule } from '../../common';
import { AdminTranscriptionJobController } from './admin-transcription-job.controller';
import { SmrProxyController } from './smr-proxy.controller';
import { SttWsGateway } from './stt-ws.gateway';
import { TranscriptionJobController } from './transcription-job.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 120000,
      maxRedirects: 3,
    }),
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    StreamingSessionServiceModule,
    TenantServiceModule,
    TenantBucketServiceModule,
    PipelineServiceModule,
    CoreDatabaseModule,
    // TASK-310 W7.A.9 (AC-3): exposes `StreamSessionTenantBindingService`
    // to `TranscriptionJobController` so it can bind on create / clear on close.
    TenantOwnedResourceModule,
  ],
  controllers: [TranscriptionJobController, AdminTranscriptionJobController, SmrProxyController],
  providers: [SttWsGateway],
  exports: [SttWsGateway],
})
export class StreamingModule {}
