import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '../../baseServices/_meta/config';
import { UsageLedgerServiceModule } from '../../usageLedger';
import { VoiceProfileServiceModule } from '../../user/voiceProfile/voiceProfile.service.module';
import { StreamingSessionService } from './streamingSession.service';
import { StreamingAudioBridgeService } from './streamingAudioBridge.service';

/**
 * Streaming Session Service Module
 *
 * Provides WebSocket streaming session management for STT.
 * Brand-new module — does NOT reuse or touch the old STT v1 gateway.
 *
 * Imports:
 * - HttpModule: HTTP client for calling STT internal API
 * - ConfigModule: Access to STT_URL and Redis config
 * - UsageLedgerServiceModule: `IUsageLedgerService` for the
 *   `transcribe.stream` emission on session teardown.
 *
 * Providers:
 * - StreamingSessionService: Session lifecycle via STT HTTP API
 * - StreamingAudioBridgeService: Audio forwarding via Redis Streams
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 0,
    }),
    ConfigModule,
    UsageLedgerServiceModule,
    // TASK-887 — `IVoiceProfileService.listForRuntime` supplies the enrolled profiles the
    // session pushes to apps/stt so diarization can label a matched speaker.
    VoiceProfileServiceModule,
  ],
  providers: [StreamingSessionService, StreamingAudioBridgeService],
  exports: [StreamingSessionService, StreamingAudioBridgeService],
})
export class StreamingSessionServiceModule {}
