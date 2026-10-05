import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { RedisCacheModule } from '../../baseServices/redis';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { DocumentTemplateServiceModule } from '../../document-template/document-template.service.module';
import { NoteInputComposerService } from './note-input-composer.service';
import { NoteTokenCounterToken, TextTokenCountClient } from './text-token-count.client';

/**
 * The note input composer and its token counter. The composer reads the record model through
 * `CoreDatabaseModule`, its budget settings through `EffectiveSettingsModule`, the template headings
 * through `DocumentTemplateServiceModule`, and caches plans in Redis.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    EffectiveSettingsModule,
    DocumentTemplateServiceModule,
    RedisCacheModule.register(),
  ],
  providers: [NoteInputComposerService, TextTokenCountClient, { provide: NoteTokenCounterToken, useExisting: TextTokenCountClient }],
  exports: [NoteInputComposerService, NoteTokenCounterToken],
})
export class NoteCompositionServiceModule {}
