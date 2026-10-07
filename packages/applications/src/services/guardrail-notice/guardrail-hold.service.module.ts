import { Global, Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ConsultationLifecycleModule } from '../consultation/lifecycle/lifecycle.module';
import { GuardrailHoldService, IGuardrailHoldService } from './guardrail-hold.service';

/**
 * TASK-1050 W2e — the ONE guardrail hold-entry path, `@Global()` so every caller resolves it with
 * no import edge: the evaluation ingest, the run watcher in apps/api (`run.paused` reason
 * `guardrail_hold`) and the live lane's egress-redaction path. Inject `GuardrailHoldService` or
 * `IGuardrailHoldService`. `ConsultationLifecycleModule` supplies the pause and the event publisher.
 */
@Global()
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConsultationLifecycleModule],
  providers: [GuardrailHoldService, { provide: IGuardrailHoldService, useExisting: GuardrailHoldService }],
  exports: [GuardrailHoldService, IGuardrailHoldService],
})
export class GuardrailHoldServiceModule {}
