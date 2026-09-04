import {
  AgentServiceModule,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
  EffectiveConfigServiceModule,
  SttInternalServiceModule,
  StreamingSessionServiceModule,
} from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AgentInternalController } from './agent-internal.controller';
import { EffectiveConfigController } from './effective-config.controller';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { ModelRegistryInternalController } from './model-registry-internal.controller';
import { SttInternalController } from './stt-internal.controller';

@Module({
  // EffectiveConfigServiceModule backs the per-service config pull.
  // AsrAgentResolverServiceModule backs the batch-worker BYO override pull
  // (TASK-861 follow-up: through TASK-862's ProviderCredentialResolver).
  // StreamingSessionServiceModule backs the reaper usage push-back.
  // AiProviderConnectionServiceModule backs `model-registry-credential` — both
  // the generic `ModelRegistryInternalController` route ( follow-on)
  // and the superseded STT-specific one on `SttInternalController` — the
  // weight fetcher's route to the HF token and the model-store S3 pair.
  imports: [
    SttInternalServiceModule,
    EffectiveConfigServiceModule,
    AsrAgentResolverServiceModule,
    StreamingSessionServiceModule,
    AiProviderConnectionServiceModule,
    // TASK-863 — `AgentInternalController` (`/internal/agents/resolve`) resolves through the ONE agent resolver.
    AgentServiceModule,
  ],
  controllers: [SttInternalController, EffectiveConfigController, ModelRegistryInternalController, AgentInternalController],
  // Applied via `@UseGuards` on the controller, but provided here so Nest can
  // inject SecretsService into it.
  providers: [InternalServiceTokenGuard],
})
export class InternalModule {}
