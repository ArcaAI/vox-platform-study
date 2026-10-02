import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { ComposedPromptRecorderModule } from './composed-prompt-recorder.module';
import { ComposedPromptService } from './composed-prompt.service';
import { IComposedPromptService } from './IComposedPromptService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule, ComposedPromptRecorderModule],
  providers: [ComposedPromptService, { provide: IComposedPromptService, useExisting: ComposedPromptService }],
  exports: [IComposedPromptService, ComposedPromptService],
})
export class ComposedPromptServiceModule {}
