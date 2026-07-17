import { AiModelServiceModule, AiTaskDefaultServiceModule } from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiInferenceClient } from './ai-inference.client';
import { AiInferenceController } from './ai-inference.controller';

/**
 * AiInferenceModule (TASK-446) — the user-plane `/ai/*` inference proxy over the
 * Guardrail + NLP Python services (Agent Playground Guardrails/NER tabs).
 * `IConfigService` is global (ConfigModule.forRoot in AppModule), so only
 * HttpModule is imported — plus `AiTaskDefaultServiceModule` (TASK-506) so the
 * NLP routes can resolve the tenant's effective default model, and
 * `AiModelServiceModule` (r2605 Finding B) so a caller-supplied model override
 * is validated against the registry before being forwarded. Kept separate
 * from AiServiceAdminModule so the read-only admin plane stays untouched.
 */
@Module({
  imports: [HttpModule, AiTaskDefaultServiceModule, AiModelServiceModule],
  controllers: [AiInferenceController],
  providers: [AiInferenceClient],
})
export class AiInferenceModule {}
