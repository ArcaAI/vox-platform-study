import { MediaUploadServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';

/** `/media/**` — the tenant media upload plane (TASK-1038 F1). */
@Module({
  imports: [MediaUploadServiceModule],
  controllers: [MediaController],
})
export class MediaModule {}
