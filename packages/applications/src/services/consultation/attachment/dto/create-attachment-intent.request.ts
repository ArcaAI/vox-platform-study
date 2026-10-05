import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ATTACHMENT_KINDS, ATTACHMENT_PURPOSES, AttachmentKind, AttachmentPurpose } from '../attachment-policy';

/** `POST consultations/:id/attachments` — declares the file; the bytes follow. */
export class CreateAttachmentIntentRequest {
  @ApiProperty({ description: 'What the file is.', enum: ATTACHMENT_KINDS })
  @IsIn(ATTACHMENT_KINDS)
  kind!: AttachmentKind;

  @ApiProperty({ description: 'Declared MIME type; the stored bytes are sniffed against it at completion.', example: 'application/pdf' })
  @IsString()
  @MaxLength(127)
  mime!: string;

  @ApiProperty({ description: 'Declared size in bytes.', example: 20480 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @ApiProperty({ description: 'SHA-256 of the bytes, lower-case hex.', example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'sha256 must be 64 lower-case hex characters' })
  sha256!: string;

  @ApiPropertyOptional({ description: 'Original file name (PHI-prone: stored encrypted, never put in an object key).' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional({ description: 'Whether the file belongs to the consultation record or backs a feedback entry.', enum: ATTACHMENT_PURPOSES, default: 'attachment' })
  @IsOptional()
  @IsIn(ATTACHMENT_PURPOSES)
  purpose?: AttachmentPurpose;

  @ApiPropertyOptional({ description: 'The encounter (visit sequence) the file belongs to; defaults to the current one.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  encounterSeq?: number;
}
