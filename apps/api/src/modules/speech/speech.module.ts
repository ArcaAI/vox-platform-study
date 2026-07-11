import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SpeechProxyController } from './speech-proxy.controller';

// IConfigService + SecretsService are provided app-wide by CommonServiceModule
// (under the app's @Global core), so this module only needs the HTTP client.
@Module({
  imports: [
    HttpModule.register({
      timeout: 120000,
      maxRedirects: 3,
    }),
  ],
  controllers: [SpeechProxyController],
})
export class SpeechModule {}
