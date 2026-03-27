import {
  S3ServiceModule,
  StreamingSessionServiceModule,
  TenantServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
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
    S3ServiceModule,
    CoreDatabaseModule,
  ],
  controllers: [TranscriptionJobController, SmrProxyController],
  providers: [SttWsGateway],
  exports: [SttWsGateway],
})
export class StreamingModule {}
