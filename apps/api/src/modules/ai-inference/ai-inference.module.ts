import { AiModelServiceModule, AiRuntimeProfileServiceModule, AiTaskDefaultServiceModule, UsageLedgerServiceModule } from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiInferenceClient } from './ai-inference.client';
import { AiInferenceController } from './ai-inference.controller';

/**
 * AiInferenceModule — the user-plane `/ai/*` inference proxy over the
 * Guardrail + NLP Python services (Agent Playground Guardrails/NER tabs).
 * `IConfigService` is global (ConfigModule.forRoot in AppModule), so only
 * HttpModule is imported — plus `AiTaskDefaultServiceModule` so the
 * NLP routes can resolve the tenant's effective default model, and
 * `AiModelServiceModule` so a caller-supplied model override
 * is validated against the registry before being forwarded. Kept separate
 * from AiServiceAdminModule so the read-only admin plane stays untouched.
 * `UsageLedgerServiceModule` supplies `IUsageLedgerService` for the
 * Playground `ner.extract` usage-ledger emission.
 */
@Module({
  // AiRuntimeProfileServiceModule supplies the hyperparameter
  // profile resolver injected alongside `model_name`.
  imports: [HttpModule, AiTaskDefaultServiceModule, AiModelServiceModule, AiRuntimeProfileServiceModule, UsageLedgerServiceModule],
  controllers: [AiInferenceController],
  providers: [AiInferenceClient],
})
export class AiInferenceModule {}
