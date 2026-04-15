import { PipelineServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
  import { AudioPipelinePublicController } from './audio-pipeline-public.controller';
import { AudioPipelineController } from './audio-pipeline.controller';

@Module({
  imports: [PipelineServiceModule],
  controllers: [AudioPipelineController, AudioPipelinePublicController],
})
export class PipelineModule {}
