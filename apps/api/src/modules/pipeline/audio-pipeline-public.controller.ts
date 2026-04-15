import { PipelineResponse, PipelineService } from '@arcaai/applications';
import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize } from '../../decorators';

@ApiBearerAuth()
@ApiTags('audio-pipelines')
@Controller('audio/pipelines')
@Authorize()
export class AudioPipelinePublicController {
  constructor(private readonly pipelineService: PipelineService) {}

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    multi: true,
  })
  async fetchAll(): Promise<PipelineResponse[]> {
    return this.pipelineService.getAll();
  }
}
