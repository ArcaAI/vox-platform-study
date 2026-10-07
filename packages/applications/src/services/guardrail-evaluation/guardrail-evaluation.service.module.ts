import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ConsultationLifecycleModule } from '../consultation/lifecycle/lifecycle.module';
import { GuardrailEvaluationAdminService } from './guardrail-evaluation-admin.service';
import { GuardrailEvaluationIngestService } from './guardrail-evaluation-ingest.service';

/**
 * TASK-1050 W2e — the gateway's guardrail evaluation plane: the internal ingest of guardrail's
 * outbox (`POST internal/guardrail/evaluations`) and the admin read (list + withheld review).
 *
 * `ConsultationLifecycleModule` supplies the lifecycle commands (a held RECORDING consultation is
 * paused) and the event publisher (the state-only hold event). SecretsService is global.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConsultationLifecycleModule],
  providers: [GuardrailEvaluationIngestService, GuardrailEvaluationAdminService],
  exports: [GuardrailEvaluationIngestService, GuardrailEvaluationAdminService],
})
export class GuardrailEvaluationServiceModule {}
