import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  CheckpointDownloadUrlResponse,
  CompleteCheckpointUploadRequest,
  CreateCheckpointRequest,
  IActiveUserContext,
  InitCheckpointUploadRequest,
  InitCheckpointUploadResponse,
  ITenantCheckpointService,
  ListCheckpointsQuery,
  ListRestoresQuery,
  PaginatedTenantCheckpointResponse,
  PaginatedTenantCheckpointRestoreResponse,
  RestoreCheckpointRequest,
  TenantCheckpointResponse,
  TenantCheckpointRestoreResponse,
} from '@arcaai/applications';
import { CanCreate, CanDelete, CanManage, CanRead, CanUpdate, ForbidApiKey, ForbidServiceAccount, TenantLockExempt } from '../../decorators';
import { assertTenantInScope } from '../../shared/tenant-scope';

const TENANT_PARAM = { name: 'tenantId', description: 'The tenant the checkpoints belong to', type: String } as const;

/**
 * Tenant checkpoints: sealed per-tenant backups, offline download and upload, and the locked restore.
 *
 * Tenancy: every handler first pins `:tenantId` to the caller (`assertTenantInScope`, 404 for a
 * foreign tenant — a tenant admin can neither read nor probe another tenant's archives), then the
 * service refuses the SYSTEM tenant and pins every row it loads to that same tenant id.
 *
 * Human sessions only: an API key or service account never reaches these routes (the archive holds
 * PHI and a restore overwrites a tenant). The `GET` routes are lock-exempt so a locked tenant's
 * restore can still be watched; every mutation is refused with 423 while a restore runs.
 */
@ApiBearerAuth()
@ApiTags('tenant-checkpoints')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/tenants/:tenantId/checkpoints')
export class TenantCheckpointController {
  constructor(
    @Inject(ITenantCheckpointService) private readonly service: ITenantCheckpointService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  private pin(tenantId: string): void {
    assertTenantInScope(this.cls.get('user'), tenantId, 'notfound');
  }

  // ── restores (static paths first, so `:id` never swallows them) ─────────────

  @Get('restores')
  @TenantLockExempt()
  @CanRead('TenantCheckpoint')
  @ApiOperation({
    summary: "List a tenant's checkpoint restores",
    description: 'Newest first. Stays readable while a restore is running so the console can show its progress.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiResponse({ status: 200, type: PaginatedTenantCheckpointRestoreResponse })
  @ApiResponse({ status: 403, description: 'The platform (SYSTEM) tenant cannot be checkpointed.' })
  @ApiResponse({ status: 404, description: 'Tenant not found, or not yours.' })
  listRestores(@Param('tenantId') tenantId: string, @Query() query: ListRestoresQuery): Promise<PaginatedTenantCheckpointRestoreResponse> {
    this.pin(tenantId);
    return this.service.listRestores(tenantId, query);
  }

  @Get('restores/:restoreId')
  @TenantLockExempt()
  @CanRead('TenantCheckpoint')
  @ApiOperation({ summary: 'Get one checkpoint restore', description: 'Status, per-model counts and warnings of a restore.' })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'restoreId', description: 'Restore id', type: String })
  @ApiResponse({ status: 200, type: TenantCheckpointRestoreResponse })
  @ApiResponse({ status: 403, description: 'The platform (SYSTEM) tenant cannot be checkpointed.' })
  @ApiResponse({ status: 404, description: 'Restore not found, or not yours.' })
  getRestore(@Param('tenantId') tenantId: string, @Param('restoreId') restoreId: string): Promise<TenantCheckpointRestoreResponse> {
    this.pin(tenantId);
    return this.service.getRestore(tenantId, restoreId);
  }

  // ── uploads ─────────────────────────────────────────────────────────────────

  @Post('uploads')
  @CanCreate('TenantCheckpoint')
  @ApiOperation({
    summary: 'Start a checkpoint upload',
    description:
      'Creates an UPLOADING checkpoint and returns presigned part URLs. The browser PUTs each part straight to the object store, ' +
      'then calls the complete route with the ETags. Only a file this deployment produced for this tenant passes verification.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiResponse({ status: 201, type: InitCheckpointUploadResponse })
  @ApiResponse({ status: 400, description: 'Invalid filename or size.' })
  @ApiResponse({ status: 404, description: 'Tenant not found, or not yours.' })
  @ApiResponse({ status: 413, description: 'CHECKPOINT_TOO_LARGE: the file exceeds the upload size limit.' })
  initUpload(@Param('tenantId') tenantId: string, @Body() request: InitCheckpointUploadRequest): Promise<InitCheckpointUploadResponse> {
    this.pin(tenantId);
    return this.service.initUpload(tenantId, request);
  }

  @Post('uploads/:id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('TenantCheckpoint')
  @ApiOperation({
    summary: 'Complete a checkpoint upload',
    description: 'Finishes the multipart upload and queues verification. `:id` is the multipart upload id from the start route.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Multipart upload id', type: String })
  @ApiResponse({ status: 202, type: TenantCheckpointResponse })
  @ApiResponse({ status: 400, description: 'UPLOAD_PARTS_INVALID: parts missing, duplicated or out of order.' })
  @ApiResponse({ status: 404, description: 'Upload not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'UPLOAD_NOT_IN_PROGRESS.' })
  completeUpload(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() request: CompleteCheckpointUploadRequest,
  ): Promise<TenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.completeUpload(tenantId, id, request);
  }

  @Post('uploads/:id/abort')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('TenantCheckpoint')
  @ApiOperation({ summary: 'Abort a checkpoint upload', description: 'Discards the uploaded parts; the checkpoint becomes CANCELLED.' })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Multipart upload id', type: String })
  @ApiResponse({ status: 202, type: TenantCheckpointResponse })
  @ApiResponse({ status: 404, description: 'Upload not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'UPLOAD_NOT_IN_PROGRESS.' })
  abortUpload(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<TenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.abortUpload(tenantId, id);
  }

  // ── checkpoints ─────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('TenantCheckpoint')
  @ApiOperation({
    summary: 'Create a checkpoint',
    description:
      'Queues an export of the tenant and returns the PENDING checkpoint. An optional passphrase lets the archive be opened offline; ' +
      'it is used only inside this request and cannot be recovered.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiResponse({ status: 202, type: TenantCheckpointResponse })
  @ApiResponse({ status: 400, description: 'Invalid label or passphrase.' })
  @ApiResponse({ status: 404, description: 'Tenant not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'TENANT_CHECKPOINT_BUSY: an export or restore is already running.' })
  create(@Param('tenantId') tenantId: string, @Body() request: CreateCheckpointRequest): Promise<TenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.create(tenantId, request);
  }

  @Get()
  @TenantLockExempt()
  @CanRead('TenantCheckpoint')
  @ApiOperation({ summary: "List a tenant's checkpoints", description: 'Newest first; optionally narrowed by kind and a label search.' })
  @ApiParam(TENANT_PARAM)
  @ApiResponse({ status: 200, type: PaginatedTenantCheckpointResponse })
  @ApiResponse({ status: 400, description: 'Invalid query parameter.' })
  @ApiResponse({ status: 404, description: 'Tenant not found, or not yours.' })
  list(@Param('tenantId') tenantId: string, @Query() query: ListCheckpointsQuery): Promise<PaginatedTenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.list(tenantId, query);
  }

  @Get(':id')
  @TenantLockExempt()
  @CanRead('TenantCheckpoint')
  @ApiOperation({ summary: 'Get one checkpoint', description: 'Status and export progress.' })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Checkpoint id', type: String })
  @ApiResponse({ status: 200, type: TenantCheckpointResponse })
  @ApiResponse({ status: 404, description: 'Checkpoint not found, or not yours.' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<TenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.get(tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanUpdate('TenantCheckpoint')
  @ApiOperation({ summary: 'Cancel a running checkpoint export', description: 'A running export notices the request between tables and stops.' })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Checkpoint id', type: String })
  @ApiResponse({ status: 202, type: TenantCheckpointResponse })
  @ApiResponse({ status: 404, description: 'Checkpoint not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'CHECKPOINT_NOT_CANCELLABLE: only a running export can be cancelled.' })
  cancel(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<TenantCheckpointResponse> {
    this.pin(tenantId);
    return this.service.cancel(tenantId, id);
  }

  @Post(':id/download-url')
  @HttpCode(HttpStatus.OK)
  @CanRead('TenantCheckpoint')
  @ApiOperation({
    summary: 'Issue a download URL',
    description: 'A presigned URL valid for 15 minutes. Every issuance is force-audited.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Checkpoint id', type: String })
  @ApiResponse({ status: 200, type: CheckpointDownloadUrlResponse })
  @ApiResponse({ status: 404, description: 'Checkpoint not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'CHECKPOINT_NOT_READY.' })
  downloadUrl(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<CheckpointDownloadUrlResponse> {
    this.pin(tenantId);
    return this.service.downloadUrl(tenantId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanManage('TenantCheckpoint')
  // AUTH-NOTE: manage:TenantCheckpoint is the ability gate; the real boundary is imperative in the
  // service, in this order — (1) break-glass: 428 no password/name, 401 wrong password, 400 wrong
  // name (the tenant's CURRENT name); (2) CLINICAL needs a platform admin (403
  // CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN); (3) READY; (4) not busy; (5) schema-compatible.
  @ApiOperation({
    summary: 'Restore a tenant from a checkpoint',
    description:
      'Re-enter your current password and type the tenant name (break-glass). Locks the tenant read-only, takes a safety checkpoint, ' +
      'then reconciles the chosen categories in one transaction. Clinical data is restricted to platform administrators.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Checkpoint id', type: String })
  @ApiResponse({ status: 202, type: TenantCheckpointRestoreResponse })
  @ApiResponse({ status: 400, description: 'Wrong confirmation name, or invalid categories or reason.' })
  @ApiResponse({ status: 401, description: 'Wrong password.' })
  @ApiResponse({ status: 403, description: 'CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN.' })
  @ApiResponse({ status: 404, description: 'Checkpoint not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'CHECKPOINT_NOT_READY, TENANT_CHECKPOINT_BUSY or SCHEMA_INCOMPATIBLE.' })
  @ApiResponse({ status: 428, description: 'Break-glass confirmation missing.' })
  restore(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() request: RestoreCheckpointRequest,
  ): Promise<TenantCheckpointRestoreResponse> {
    this.pin(tenantId);
    return this.service.restore(tenantId, id, request);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CanDelete('TenantCheckpoint')
  @ApiOperation({
    summary: 'Delete a checkpoint',
    description: 'Deletes the archive and soft-deletes the row. A checkpoint still being written cannot be deleted.',
  })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'id', description: 'Checkpoint id', type: String })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 404, description: 'Checkpoint not found, or not yours.' })
  @ApiResponse({ status: 409, description: 'CHECKPOINT_IN_PROGRESS or TENANT_CHECKPOINT_BUSY.' })
  async remove(@Param('tenantId') tenantId: string, @Param('id') id: string): Promise<void> {
    this.pin(tenantId);
    await this.service.delete(tenantId, id);
  }
}
