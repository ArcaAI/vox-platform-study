import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_STATUSES,
  ATTACHMENT_UPLOAD_MODES,
  AttachmentKind,
  AttachmentStatus,
  AttachmentUploadMode,
} from '../attachment-policy';

export class AttachmentUploadHeaders {
  @ApiProperty({ name: 'Content-Type' })
  'Content-Type'!: string;

  @ApiProperty({ name: 'Content-Length' })
  'Content-Length'!: string;

  @ApiPropertyOptional({ name: 'x-amz-checksum-sha256', description: 'Base64 SHA-256 the storage layer verifies on write.' })
  'x-amz-checksum-sha256'?: string;
}

/** 201 of `POST consultations/:id/attachments`. */
export class AttachmentIntentResponse {
  @ApiProperty() attachmentId!: string;
  @ApiProperty({ enum: ['INTENT'] }) status!: 'INTENT';
  @ApiProperty({ enum: ATTACHMENT_KINDS }) kind!: AttachmentKind;
  @ApiProperty({ enum: ATTACHMENT_UPLOAD_MODES }) uploadMode!: AttachmentUploadMode;
  @ApiProperty({ type: String, nullable: true, description: 'Presigned PUT URL; null when the file goes through `/content`.' })
  uploadUrl!: string | null;
  @ApiProperty({ enum: ['PUT'] }) uploadMethod!: 'PUT';
  @ApiProperty({ type: AttachmentUploadHeaders, description: 'Send these and no Authorization header.' }) uploadHeaders!: AttachmentUploadHeaders;
  @ApiProperty({ description: 'ISO timestamp the upload URL stops working.' }) uploadExpiresAt!: string;
  @ApiProperty({ description: 'ISO timestamp an unfinished intent is reaped.' }) intentExpiresAt!: string;
  @ApiProperty({ description: 'The byte ceiling the upload is signed for.' }) maxSizeBytes!: number;
}

/** 200/202 of `complete` and `content`; the shape `GET` answers too. */
export class AttachmentResponse {
  @ApiProperty() attachmentId!: string;
  @ApiProperty({ enum: ATTACHMENT_STATUSES }) status!: AttachmentStatus;
  @ApiProperty({ enum: ATTACHMENT_KINDS }) kind!: AttachmentKind;
  @ApiProperty() mime!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() sha256!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) mediaId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) contextItemId?: string | null;
  @ApiPropertyOptional({ description: 'Batch job transcribing an audio attachment.' }) transcriptionJobId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Why a FAILED attachment failed.' }) failureCode?: string | null;
}
