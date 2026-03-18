import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '../../baseServices/_meta/config';
import { StreamingSessionService } from './streamingSession.service';
import { StreamingAudioBridgeService } from './streamingAudioBridge.service';

/**
 * Streaming Session Service Module
 *
 * Provides WebSocket streaming session management for STT-V2.
 * Brand-new module — does NOT reuse or touch the old STT v1 gateway.
 *
 * Imports:
 * - HttpModule: HTTP client for calling STT-V2 internal API
 * - ConfigModule: Access to STT_V2_URL and Redis config
 *
 * Providers:
 * - StreamingSessionService: Session lifecycle via STT-V2 HTTP API
 * - StreamingAudioBridgeService: Audio forwarding via Redis Streams
 */
@Module({
    imports: [
        HttpModule.register({
            timeout: 10000,
            maxRedirects: 0,
        }),
        ConfigModule,
    ],
    providers: [
        StreamingSessionService,
        StreamingAudioBridgeService,
    ],
    exports: [
        StreamingSessionService,
        StreamingAudioBridgeService,
    ],
})
export class StreamingSessionServiceModule {}
