import { EffectiveConfigServiceModule, SttInternalServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { EffectiveConfigController } from './effective-config.controller';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { SttInternalController } from './stt-internal.controller';

@Module({
  // EffectiveConfigServiceModule backs the per-service config pull.
  imports: [SttInternalServiceModule, EffectiveConfigServiceModule],
  controllers: [SttInternalController, EffectiveConfigController],
  // Applied via `@UseGuards` on the controller, but provided here so Nest can
  // inject SecretsService into it.
  providers: [InternalServiceTokenGuard],
})
export class InternalModule {}
