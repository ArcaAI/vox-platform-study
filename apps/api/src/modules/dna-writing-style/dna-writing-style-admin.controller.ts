import {
  IDnaWritingStyleService,
  DnaReportResponse,
  DnaVersionResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  PaginatedQuery,
  HttpMethod,
  type DnaJobResponse,
} from '@arcaai/applications';
import { DnaJobResponseDto, DnaJobStatusResponseDto } from './dna-writing-style.dto';
import { PaginatedDnaReportResponse } from './dto';
import { JobQueue } from '@arcaai/domains';
import { Controller, Body, Param, Inject, Get, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { ApiEndpoint, Authorize } from '../../decorators';
import { getDnaJobStatus, streamDnaJobStatus } from './dna-writing-style-job-stream';

@ApiBearerAuth()
@ApiTags('admin-dna-writing-styles')
@Controller('admin/dna-writing-styles')
@Authorize(['manage', 'all'])
export class DnaWritingStyleAdminController {
  constructor(
    @Inject(IDnaWritingStyleService)
    private readonly dnaService: IDnaWritingStyleService,
    @InjectQueue(JobQueue.GenerateDnaReport)
    private readonly dnaQueue: Queue,
  ) {}

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    multi: true,
  })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled reports in results' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query() queryParams: PaginatedQuery & { includeDisabled?: string }): Promise<PaginatedDnaReportResponse> {
    const reports = await this.dnaService.listReports({
      includeDisabled: queryParams?.includeDisabled === 'true',
    });
    const page = queryParams?.page ?? 0;
    const limit = queryParams?.limit ?? 10;
    const start = page > 0 ? (page - 1) * limit : 0;
    const paged = limit > 0 ? reports.slice(start, start + limit) : reports;

    return {
      data: paged,
      count: reports.length,
      limit,
      page,
    };
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
    return this.dnaService.updateDnaReport(reportId, dto, { bypassOwnershipCheck: true });
  }

  @ApiEndpoint({
    returnedModel: DnaJobResponseDto,
    method: HttpMethod.POST,
    path: 'generate/:doctorId',
    by: ['doctorId'],
  })
  @ApiParam({ name: 'doctorId', description: 'Target doctor ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input' })
  async generateForDoctor(@Param('doctorId') doctorId: string, @Body() dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    return this.dnaService.generateDnaReport(doctorId, dto);
  }

  @ApiEndpoint({
    returnedModel: DnaVersionResponse,
    multi: true,
    path: ':reportId/versions',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getVersions(@Param('reportId') reportId: string): Promise<DnaVersionResponse[]> {
    return this.dnaService.getVersions(reportId);
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get DNA generation job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'Job status', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId);
  }

  @Get('jobs/:jobId/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream DNA generation job status via SSE' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'SSE job status stream' })
  streamJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return streamDnaJobStatus(this.dnaQueue, jobId);
  }
}
