import { TenantTtsConfigServiceModule } from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SpeechProxyController } from './speech-proxy.controller';
import { TtsWsGateway } from './tts-ws.gateway';

// IConfigService + SecretsService are provided app-wide by CommonServiceModule
// (under the app's @Global core), and StreamTicketService is @Global, so this
// module only needs the HTTP client, the per-tenant TTS config resolver
// (TASK-496), and to register the WS-duplex gateway.
@Module({
  imports: [
    HttpModule.register({
      timeout: 120000,
      maxRedirects: 3,
    }),
    TenantTtsConfigServiceModule,
  ],
  controllers: [SpeechProxyController],
  providers: [TtsWsGateway],
})
export class SpeechModule {}
