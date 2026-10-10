import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { RedisCacheModule } from '../../baseServices/redis';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { DocumentTemplateServiceModule } from '../../document-template/document-template.service.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { NoteInputComposerService } from './note-input-composer.service';
import { NoteTokenCounterToken, TextTokenCountClient } from './text-token-count.client';
import { GovernedPromptServiceModule } from '../../governed-prompt/governed-prompt.service.module';
import { ContextMedicalJudgeServiceModule } from '../../guardrail-context-judge/context-medical-judge.service.module';

/**
 * The note input composer and its token counter. The composer reads the record model through
 * `CoreDatabaseModule`, its budget settings through `EffectiveSettingsModule`, the template headings
 * through `DocumentTemplateServiceModule`, the warm-start policy through `HarnessPolicyServiceModule`,
 * and caches plans in Redis.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    EffectiveSettingsModule,
    DocumentTemplateServiceModule,
    HarnessPolicyServiceModule,
    RedisCacheModule.register(),
    // TASK-1047 FC-3/FC-4 — the governed-prompt registry (a leaf module: no cycle).
    GovernedPromptServiceModule,
    // TASK-1059 C-0 — the runtime context medical judge (a leaf module: no cycle).
    ContextMedicalJudgeServiceModule,
  ],
  providers: [NoteInputComposerService, TextTokenCountClient, { provide: NoteTokenCounterToken, useExisting: TextTokenCountClient }],
  exports: [NoteInputComposerService, NoteTokenCounterToken],
})
export class NoteCompositionServiceModule {}
