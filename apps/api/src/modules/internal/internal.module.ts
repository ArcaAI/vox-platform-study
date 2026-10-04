import {
  AgentServiceModule,
  AgentVersionResolverService,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
  ComposedPromptServiceModule,
  EffectiveConfigServiceModule,
  EntitlementsServiceModule,
  ModelServingSpecServiceModule,
  SttInternalServiceModule,
  StreamingSessionServiceModule,
} from '@arcaai/applications';
import { TenantLockModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { AgentInternalController } from './agent-internal.controller';
import { AgentVersionInternalController } from './agent-version-internal.controller';
import { ComposedPromptInternalController } from './composed-prompt-internal.controller';
import { EffectiveConfigController } from './effective-config.controller';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { ModelRegistryInternalController } from './model-registry-internal.controller';
import { ModelServingInternalController } from './model-serving-internal.controller';
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
    TenantLockModule,
    SttInternalServiceModule,
    EffectiveConfigServiceModule,
    AsrAgentResolverServiceModule,
    StreamingSessionServiceModule,
    AiProviderConnectionServiceModule,
    // TASK-863 — `AgentInternalController` (`/internal/agents/resolve`) resolves through the ONE agent resolver.
    AgentServiceModule,
    // TASK-890 — `IEntitlementsService` for the workflow-step `monthlyLlmTokens`
    // gate on that same route (§3.13): the harness calls TEXT directly, so this
    // resolution is the only gateway touch a durable `core.agent` step makes.
    EntitlementsServiceModule,
    // TASK-1021 — `ModelServingInternalController` (`/internal/models/:slug/serving-spec`), apps/vllm's engine-build contract.
    ModelServingSpecServiceModule,
    // `ComposedPromptInternalController` (`/internal/composed-prompts`) — the harness's composed-prompt records (OD-9).
    ComposedPromptServiceModule,
    // TASK-1038 — `AgentRepository` for the pinned-version lookup.
    CoreDatabaseModule,
  ],
  controllers: [
    SttInternalController,
    EffectiveConfigController,
    ModelRegistryInternalController,
    AgentInternalController,
    // TASK-1038 — GET internal/agents/:slug/versions/:versionNumber/resolved (the harness's pinned version).
    AgentVersionInternalController,
    ModelServingInternalController,
    ComposedPromptInternalController,
  ],
  // Applied via `@UseGuards` on the controller, but provided here so Nest can
  // inject SecretsService into it.
  providers: [InternalServiceTokenGuard, AgentVersionResolverService],
})
export class InternalModule {}
