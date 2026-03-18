import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import {
    TenantServiceModule,
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    StreamingSessionServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { SttWsGateway } from './stt-ws.gateway';
import { TranscriptionJobController } from './transcription-job.controller';
import { SmrProxyController } from './smr-proxy.controller';

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
        CoreDatabaseModule,
    ],
    controllers: [TranscriptionJobController, SmrProxyController],
    providers: [SttWsGateway],
    exports: [SttWsGateway],
})
export class StreamingModule {}
