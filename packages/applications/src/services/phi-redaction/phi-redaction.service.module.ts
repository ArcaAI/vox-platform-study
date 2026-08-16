import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { GuardrailPhiRedactor } from './guardrail-phi-redactor.service';

/**
 * DI module for the `IPhiRedactor` port (TASK-710). Binds it to
 * `GuardrailPhiRedactor`, an HTTP client over the guardrail service's
 * `POST /api/guardrail/redact`. `SecretsService` (for `GUARDRAIL_SERVICE_TOKEN`)
 * comes from the `@Global` `SecretsModule` and needs no explicit import here.
 *
 * Importing this module is what turns `GateEditMiningService`'s fail-closed
 * "no redactor ⇒ mine nothing" into "redactor present ⇒ mine redacted
 * exemplars" — see `gate-edit-mining.service.module.ts`'s doc comment.
 */
@Module({
  imports: [HttpModule, ConfigModule],
  providers: [
    {
      provide: IPhiRedactor,
      useClass: GuardrailPhiRedactor,
    },
  ],
  exports: [IPhiRedactor],
})
export class PhiRedactionServiceModule {}
