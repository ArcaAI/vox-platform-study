import {
  AttachmentIntentResponse,
  AttachmentResponse,
  CreateAttachmentIntentRequest,
  IConsultationAttachmentService,
  IConsultationAttachmentServiceToken,
} from '@arcaai/applications';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { ConsultationAccessHelper } from './consultation-access.helper';

/**
 * Memory-safety bound for the gateway multipart fallback. The effective, tenant-governed
 * ceiling (`consultation.attachments.multipartMaxMb`) is enforced by the service on the buffer.
 */
const MULTIPART_HARD_CEILING_BYTES = 256 * 1024 * 1024;

const ATTACHMENT_ERRORS =
  '404 consultation/attachment (cross-tenant); 409 CONSULTATION_APPROVED / CONSULTATION_CLOSED / QUOTA_EXCEEDED / ATTACHMENT_NOT_UPLOADED / ' +
  'IDEMPOTENCY_KEY_IN_FLIGHT / IDEMPOTENCY_KEY_REUSED; 410 ATTACHMENT_INTENT_EXPIRED; 413 ATTACHMENT_TOO_LARGE; 415 ATTACHMENT_TYPE_UNSUPPORTED / ' +
  'ATTACHMENT_CONTENT_MISMATCH; 422 ATTACHMENT_KIND_UNSUPPORTED / ATTACHMENT_CHECKSUM_MISMATCH; 503 MEDIA_STORAGE_UNAVAILABLE.';

/**
 * Files handed to a consultation outside the live stream: intent, PUT, complete. A thin shell:
 * the access check (404 cross-tenant), then the service, which owns every other rule.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
@RequiredScopes('consultation:session:write')
export class ConsultationAttachmentController {
  constructor(
    private readonly access: ConsultationAccessHelper,
    @Inject(IConsultationAttachmentServiceToken) private readonly attachments: IConsultationAttachmentService,
  ) {}

  @Post(':id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Declare a file for a consultation and get an upload target',
    description: `Same Idempotency-Key and body answers the same attachment. Errors: ${ATTACHMENT_ERRORS}`,
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Replays with the same key and body return the same attachment.' })
  @ApiResponse({ status: 201, type: AttachmentIntentResponse })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant).' })
  @ApiResponse({ status: 409, description: 'Consultation closed/approved, quota exceeded, or Idempotency-Key conflict.' })
  @ApiResponse({ status: 422, description: 'ATTACHMENT_KIND_UNSUPPORTED (lists supportedKinds).' })
  // AUTH-NOTE: ownership (owner doctor, CASL manage, or a service account) is enforced imperatively
  // in `ConsultationAccessHelper.assertWrite`; the scopes only say a caller MAY write a session.
  async createIntent(
    @Param('id') id: string,
    @Body() request: CreateAttachmentIntentRequest,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<AttachmentIntentResponse> {
    await this.access.assertWrite(id);
    return this.attachments.createIntent(id, request, idempotencyKey);
  }

  @Post(':id/attachments/:attachmentId/complete')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Complete an upload',
    description: `Verifies the object and dispatches by kind. 200 when READY, 202 while PROCESSING (audio, or a large object verified in the background). Errors: ${ATTACHMENT_ERRORS}`,
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, type: AttachmentResponse })
  @ApiResponse({ status: 202, type: AttachmentResponse, description: 'Processing continues in the background; poll the attachment.' })
  @ApiResponse({ status: 404, description: 'Consultation or attachment not found (or cross-tenant).' })
  @ApiResponse({ status: 409, description: 'ATTACHMENT_NOT_UPLOADED (retryable), quota, or consultation closed.' })
  async complete(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttachmentResponse> {
    await this.access.assertWrite(id);
    return this.withProcessingStatus(res, await this.attachments.complete(id, attachmentId));
  }

  @Post(':id/attachments/:attachmentId/content')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes('svc:consultation:session:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTIPART_HARD_CEILING_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload the file through the gateway (fallback when no upload URL was issued)',
    description: `Multipart field \`file\`. Same response and 200/202 rule as complete. Errors: ${ATTACHMENT_ERRORS}`,
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, type: AttachmentResponse })
  @ApiResponse({ status: 202, type: AttachmentResponse, description: 'Processing continues in the background.' })
  @ApiResponse({ status: 400, description: 'No `file` part.' })
  @ApiResponse({ status: 404, description: 'Consultation or attachment not found (or cross-tenant).' })
  @ApiResponse({ status: 413, description: 'ATTACHMENT_TOO_LARGE for the gateway upload ceiling.' })
  async uploadContent(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttachmentResponse> {
    await this.access.assertWrite(id);
    if (!file?.buffer) throw new BadRequestException('A multipart `file` part is required');
    return this.withProcessingStatus(res, await this.attachments.uploadContent(id, attachmentId, { buffer: file.buffer, mimeType: file.mimetype }));
  }

  @Get(':id/attachments')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({ summary: 'List the consultation attachments' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 200, type: [AttachmentResponse] })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant).' })
  async list(@Param('id') id: string): Promise<AttachmentResponse[]> {
    await this.access.assertRead(id);
    return this.attachments.list(id);
  }

  @Get(':id/attachments/:attachmentId')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({ summary: 'Read one attachment (poll a PROCESSING one)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, type: AttachmentResponse })
  @ApiResponse({ status: 404, description: 'Consultation or attachment not found (or cross-tenant).' })
  async get(@Param('id') id: string, @Param('attachmentId') attachmentId: string): Promise<AttachmentResponse> {
    await this.access.assertRead(id);
    return this.attachments.get(id, attachmentId);
  }

  private withProcessingStatus(res: Response, result: AttachmentResponse): AttachmentResponse {
    res.status(result.status === 'PROCESSING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }
}
