import {
  IDnaWritingStyleService,
  DnaReportResponse,
  DnaVersionResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  HttpMethod,
  type DnaJobResponse,
} from '@arcaai/applications';
import { DnaJobResponseDto, DnaJobStatusResponseDto } from './dna-writing-style.dto';
import { JobQueue } from '@arcaai/domains';
import { Controller, Body, Param, Inject, ForbiddenException, NotFoundException, UnauthorizedException, Get, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { Observable } from 'rxjs';
import { ApiEndpoint, Authorize } from '../../decorators';
import { getDnaJobStatus, streamDnaJobStatus } from './dna-writing-style-job-stream';

@ApiBearerAuth()
@ApiTags('dna-writing-styles')
@Controller('dna-writing-styles')
@Authorize()
export class DnaWritingStyleController {
  constructor(
    @Inject(IDnaWritingStyleService)
    private readonly dnaService: IDnaWritingStyleService,
    private readonly cls: ClsService<IActiveUserContext>,
    @InjectQueue(JobQueue.GenerateDnaReport)
    private readonly dnaQueue: Queue,
  ) {}

  private getDoctorId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }

  @ApiEndpoint({
    returnedModel: DnaJobResponseDto,
    method: HttpMethod.POST,
    path: 'generate',
  })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input' })
  async generate(@Body() dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    return this.dnaService.generateDnaReport(this.getDoctorId(), dto);
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    path: 'my-style',
  })
  @ApiResponse({ status: 404, description: 'No DNA style found for current user' })
  async getMyStyle(): Promise<DnaReportResponse> {
    const report = await this.dnaService.getDnaReport(this.getDoctorId());
    if (!report) {
      throw new NotFoundException('No DNA writing style found for current user');
    }
    return report;
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    path: 'doctor/:doctorId',
    by: ['doctorId'],
  })
  @ApiParam({ name: 'doctorId', description: 'Doctor ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot access another doctor's DNA style" })
  @ApiResponse({ status: 404, description: 'No DNA style found for doctor' })
  async getByDoctor(@Param('doctorId') doctorId: string): Promise<DnaReportResponse> {
    const currentUserId = this.getDoctorId();
    if (doctorId !== currentUserId) {
      throw new ForbiddenException("Cannot access another doctor's DNA writing style");
    }
    const report = await this.dnaService.getDnaReport(doctorId);
    if (!report) {
      throw new NotFoundException(`No DNA writing style found for doctor ${doctorId}`);
    }
    return report;
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    method: HttpMethod.PATCH,
    path: ':reportId',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async update(@Param('reportId') reportId: string, @Body() dto: UpdateDnaReportRequest): Promise<DnaReportResponse> {
    return this.dnaService.updateDnaReport(reportId, dto);
  }

  @ApiEndpoint({
    returnedModel: DnaVersionResponse,
    multi: true,
    path: ':reportId/versions',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot access another doctor's report versions" })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getVersions(@Param('reportId') reportId: string): Promise<DnaVersionResponse[]> {
    return this.dnaService.getVersionsForDoctor(reportId, this.getDoctorId());
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get current user DNA generation job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'Job status', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId);
  }

  @Get('jobs/:jobId/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream current user DNA generation job status via SSE' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'SSE job status stream' })
  streamJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return streamDnaJobStatus(this.dnaQueue, jobId);
  }
}
