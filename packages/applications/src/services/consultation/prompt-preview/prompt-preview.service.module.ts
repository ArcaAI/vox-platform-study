import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices/common.service.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { TextRequestServiceModule } from '../../text-request/text-request.service.module';
import { HarnessInternalServiceModule } from '../harness/harness-internal.service.module';
import { GuardrailPiiDetector } from './guardrail-pii-detector';
import { PromptPreviewService } from './prompt-preview.service';

/** The Prompt Inspector (`POST admin/consultations/:consultationId/prompt-preview`). */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    HarnessInternalServiceModule,
    HarnessPolicyServiceModule,
    EffectiveSettingsModule,
    TextRequestServiceModule,
  ],
  providers: [GuardrailPiiDetector, PromptPreviewService],
  exports: [PromptPreviewService],
})
export class PromptPreviewServiceModule {}
