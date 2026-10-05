import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { ComposedPromptRecorder } from './composed-prompt.recorder';

/**
 * The ONE composed-prompt writer, on its own so `TextRequestServiceModule` (every gateway → TEXT
 * call) can record without importing the admin read surface.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ComposedPromptRecorder],
  exports: [ComposedPromptRecorder],
})
export class ComposedPromptRecorderModule {}
