import {
  AiModelServiceModule,
  AiRoutingPolicyServiceModule,
  TenantNlpTaskInstructionsServiceModule,
  UsageLedgerServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiInferenceClient } from './ai-inference.client';
import { AiInferenceController } from './ai-inference.controller';
import { AiInferenceRedirectShimController } from './ai-inference-redirect.shim.controller';
import { SafetyCheckController } from './safety-check.controller';

/**
 * AiInferenceModule — the user-plane `/ai/*` inference proxy over the
 * Guardrail + NLP Python services (Agent Playground Guardrails/NER tabs).
 * `IConfigService` is global (ConfigModule.forRoot in AppModule), so only
 * HttpModule is imported — plus `AiRoutingPolicyServiceModule` so the
 * NLP routes can resolve the SYSTEM routing election for `nlp.*`, and
 * `AiModelServiceModule` so a caller-supplied model override
 * is validated against the registry before being forwarded. Kept separate
 * from AiServiceAdminModule so the read-only admin plane stays untouched.
 * `UsageLedgerServiceModule` supplies `IUsageLedgerService` for the
 * Playground `ner.extract` usage-ledger emission — and, since TASK-957 F-7b,
 * for the `nlp.classify` rows `/diagnosis` writes and the `generate` +
 * `guardrail.validate` rows the DELEGATED `/topic` and `/intent` routes write
 * from the LLM spend `apps/nlp` now carries back. The same module exports
 * `IComputeDeviceResolver`, which those LLM rows need to decide whether a
 * self-hosted leg's seconds are a GPU or a CPU second.
 * `TenantNlpTaskInstructionsServiceModule` supplies
 * `ITenantNlpTaskInstructionsService` so `/ai/nlp/topic`/`/ai/nlp/intent` can
 * resolve the tenant's topic/intent instruction content before proxying.
 */
@Module({
  imports: [HttpModule, AiRoutingPolicyServiceModule, AiModelServiceModule, UsageLedgerServiceModule, TenantNlpTaskInstructionsServiceModule],
  controllers: [AiInferenceController, SafetyCheckController, AiInferenceRedirectShimController],
  providers: [AiInferenceClient],
})
export class AiInferenceModule {}
