import { PipelineServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AudioPipelineCatalogController } from './audio-pipeline-catalog.controller';
import { AudioPipelineController } from './audio-pipeline.controller';

@Module({
  imports: [PipelineServiceModule],
  controllers: [AudioPipelineController, AudioPipelineCatalogController],
})
export class PipelineModule {}
