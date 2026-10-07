import { Module } from '@nestjs/common';
import { GuardrailEvaluationServiceModule, TenantLockModule } from '@arcaai/applications';
import { InternalServiceTokenGuard } from '../internal/internal-service-token.guard';
import { GuardrailEvaluationInternalController } from './guardrail-evaluation-internal.controller';

/**
 * TASK-1050 W2e — the internal guardrail evaluation ingest. Imported by `ConsultationModule` (the
 * hold it enters is a consultation concern), so the app module needs no change.
 */
@Module({
  imports: [GuardrailEvaluationServiceModule, TenantLockModule],
  controllers: [GuardrailEvaluationInternalController],
  // Applied via `@UseGuards` on the controller, provided here so Nest can inject SecretsService into it.
  providers: [InternalServiceTokenGuard],
})
export class GuardrailEvaluationInternalModule {}
