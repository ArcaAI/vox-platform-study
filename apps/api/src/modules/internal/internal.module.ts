import {
  AiProviderConnectionServiceModule,
  EffectiveConfigServiceModule,
  SttInternalServiceModule,
  StreamingSessionServiceModule,
  TenantSttConfigServiceModule,
} from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { EffectiveConfigController } from './effective-config.controller';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { ModelRegistryInternalController } from './model-registry-internal.controller';
import { SttInternalController } from './stt-internal.controller';

@Module({
  // EffectiveConfigServiceModule backs the per-service config pull.
  // TenantSttConfigServiceModule backs the batch-worker BYO override pull.
  // StreamingSessionServiceModule backs the reaper usage push-back.
  // AiProviderConnectionServiceModule backs `model-registry-credential` — both
  // the generic `ModelRegistryInternalController` route (TASK-855 follow-on)
  // and the superseded STT-specific one on `SttInternalController` — the
  // weight fetcher's route to the HF token and the model-store S3 pair.
  imports: [
    SttInternalServiceModule,
    EffectiveConfigServiceModule,
    TenantSttConfigServiceModule,
    StreamingSessionServiceModule,
    AiProviderConnectionServiceModule,
  ],
  controllers: [SttInternalController, EffectiveConfigController, ModelRegistryInternalController],
  // Applied via `@UseGuards` on the controller, but provided here so Nest can
  // inject SecretsService into it.
  providers: [InternalServiceTokenGuard],
})
export class InternalModule {}
