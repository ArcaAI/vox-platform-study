import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { GuardrailHoldServiceModule } from '../guardrail-notice/guardrail-hold.service.module';
import { GuardrailEvaluationAdminService } from './guardrail-evaluation-admin.service';
import { GuardrailEvaluationIngestService } from './guardrail-evaluation-ingest.service';

/**
 * TASK-1050 W2e — the gateway's guardrail evaluation plane: the internal ingest of guardrail's
 * outbox (`POST internal/guardrail/evaluations`) and the admin read (list + withheld review).
 *
 * `GuardrailHoldServiceModule` (global) supplies the one hold-entry path. SecretsService is global.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, GuardrailHoldServiceModule],
  providers: [GuardrailEvaluationIngestService, GuardrailEvaluationAdminService],
  exports: [GuardrailEvaluationIngestService, GuardrailEvaluationAdminService],
})
export class GuardrailEvaluationServiceModule {}
