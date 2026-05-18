import {
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  InternalCompleteJobRequest,
  InternalFailJobRequest,
  InternalStartJobRequest,
  InternalUpdateProgressRequest,
  SttInternalService,
} from '@arcaai/applications';
import { Body, Controller, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authorize } from '../../decorators';

@ApiTags('internal-stt')
@ApiExcludeController()
@ApiSecurity('api-key')
@Authorize()
@Controller('internal/stt')
export class SttInternalController {
  constructor(private readonly sttInternalService: SttInternalService) {}

  private ensureInternalApiKey(request: Request): void {
    if (!request['apiKey']) {
      throw new UnauthorizedException('Internal STT endpoints require API key authentication');
    }
  }

  @Post('transcripts')
  @ApiOperation({ summary: 'Create transcript context item from STT worker output' })
  async createTranscript(@Req() request: Request, @Body() dto: CreateTranscriptRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.createTranscript(dto);
  }

  @Patch('jobs/:id/start')
  @ApiOperation({ summary: 'Mark transcription job as PROCESSING' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async startJob(@Req() request: Request, @Param('id') id: string, @Body() dto: InternalStartJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.startJob(id, dto);
  }

  @Patch('jobs/:id/progress')
  @ApiOperation({ summary: 'Update transcription job progress' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async updateProgress(@Req() request: Request, @Param('id') id: string, @Body() dto: InternalUpdateProgressRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.updateProgress(id, dto);
  }

  @Patch('jobs/:id/complete')
  @ApiOperation({ summary: 'Mark transcription job as COMPLETED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async completeJob(@Req() request: Request, @Param('id') id: string, @Body() dto: InternalCompleteJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.completeJob(id, dto);
  }

  @Patch('jobs/:id/fail')
  @ApiOperation({ summary: 'Mark transcription job as FAILED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async failJob(@Req() request: Request, @Param('id') id: string, @Body() dto: InternalFailJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.failJob(id, dto);
  }

  @Get('jobs/:id/status')
  @ApiOperation({ summary: 'Get job status (lightweight, for worker polling)' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async getJobStatus(@Req() request: Request, @Param('id') id: string) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.getJobStatus(id);
  }

  @Post('audio-records')
  @ApiOperation({ summary: 'Create audio record linked to context item' })
  async createAudioRecord(@Req() request: Request, @Body() dto: CreateAudioRecordRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.createAudioRecord(dto);
  }
}
