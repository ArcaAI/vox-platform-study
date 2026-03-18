import { PipelineServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AudioPipelineController } from './audio-pipeline.controller';

@Module({
    imports: [PipelineServiceModule],
    controllers: [AudioPipelineController],
})
export class PipelineModule {}
