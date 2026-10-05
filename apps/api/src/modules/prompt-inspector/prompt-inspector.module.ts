import { Module } from '@nestjs/common';
import { ComposedPromptServiceModule, PromptPreviewServiceModule } from '@arcaai/applications';
import { ComposedPromptAdminController } from './composed-prompt-admin.controller';
import { PromptPreviewController } from './prompt-preview.controller';

/** The Prompt Inspector (dry-run preview) and the composed-prompt incident records (OD-9). */
@Module({
  imports: [PromptPreviewServiceModule, ComposedPromptServiceModule],
  controllers: [PromptPreviewController, ComposedPromptAdminController],
})
export class PromptInspectorModule {}
