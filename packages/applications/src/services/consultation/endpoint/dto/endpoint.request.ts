import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, Max, ValidateNested } from 'class-validator';
import { ENDPOINT_REASONS } from '../endpoint.constants';

/**
 * request DTOs for the three endpoint-stage routes.
 *
 * Every field is declared here because the global `ValidationPipe` runs
 * `whitelist + forbidNonWhitelisted + forbidUnknownValues`: an undeclared field 400s the whole
 * request rather than being ignored.
 *
 * Note what is NOT declared: `FinalizeDocumentsRequest` carries no `documentKey`. That absence is
 * DD-3 expressed where it cannot be worked around — a caller cannot ask this endpoint to lock
 * only the SOAP note, because the wire has no way to say it.
 */

export class RecordSessionEndpointRequest {
  @ApiProperty({ description: 'Tenant that owns the consultation (the harness runs outside the API edge CLS middleware).' })
  @IsString()
  tenantId!: string;

  @ApiPropertyOptional({ description: 'How the session ended.', enum: ENDPOINT_REASONS })
  @IsOptional()
  @IsIn([...ENDPOINT_REASONS])
  reason?: (typeof ENDPOINT_REASONS)[number];

  @ApiPropertyOptional({ description: 'The idle bound (seconds) this run pinned, recorded alongside the disposition.', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  idleTimeoutSeconds?: number;

  @ApiPropertyOptional({ description: 'The endpoint sequence that applied to this consultation, in dispatch order.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  sequence?: string[];

  @ApiPropertyOptional({ description: 'Acting user, when one is known.' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Originating harness job, for correlation.' })
  @IsOptional()
  @IsString()
  jobId?: string;
}

export class FinalizeDocumentsRequest {
  @ApiProperty({ description: 'Tenant that owns the consultation.' })
  @IsString()
  tenantId!: string;

  @ApiPropertyOptional({
    description:
      'Lock only CONFIRMED sections, leaving PROVISIONAL ones writable. Defaults false — a signed encounter freezes whole. This narrows by STATE; there is deliberately no way to narrow by DOCUMENT (DD-3).',
  })
  @IsOptional()
  @IsBoolean()
  lockConfirmedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Acting user, when one is known.' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Originating harness job, for correlation.' })
  @IsOptional()
  @IsString()
  jobId?: string;
}

/**
 * One advisory transcript correction a clinician ACCEPTED.
 *
 * The shape mirrors what `consultation.proposeCorrections` publishes, span for span, because the
 * gateway re-verifies every span against the raw text before promoting it — a proposal whose
 * `[start, end)` no longer equals its own `original` would splice the replacement over the wrong
 * characters.
 */
export class AcceptedCorrectionProposal {
  @ApiProperty({ description: 'Stable id of the proposal, as published by consultation.proposeCorrections.' })
  @IsString()
  @MaxLength(128)
  proposalId!: string;

  @ApiProperty({ description: 'Start offset of the span in the raw transcript.' })
  @IsInt()
  @Min(0)
  start!: number;

  @ApiProperty({ description: 'End offset (exclusive) of the span in the raw transcript.' })
  @IsInt()
  @Min(0)
  end!: number;

  @ApiProperty({ description: 'The exact text the span is claimed to cover. Re-verified server-side.' })
  @IsString()
  @MaxLength(512)
  original!: string;

  @ApiProperty({ description: 'The replacement text.' })
  @IsString()
  @MaxLength(512)
  proposed!: string;

  @ApiPropertyOptional({ description: 'Correction category (spelling | medicalTerm | drugName).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({ description: 'Model confidence, 0..1.' })
  @IsOptional()
  confidence?: number;

  @ApiProperty({
    description: 'Promotion status. Only "ACCEPTED" is promotable — a proposal still marked PROPOSED is advisory and stays advisory (DD-8).',
  })
  @IsString()
  @MaxLength(32)
  status!: string;
}

export class CaptureFeedbackRequest {
  @ApiProperty({ description: 'Tenant that owns the consultation.' })
  @IsString()
  tenantId!: string;

  @ApiPropertyOptional({ description: 'The TRANSCRIPT context item the corrections were measured against. Absent ⇒ the latest transcript.' })
  @IsOptional()
  @IsString()
  contextItemId?: string;

  @ApiPropertyOptional({
    description:
      'SHA-256 of the exact text the spans were measured against. A mismatch refuses every promotion rather than splicing into drifted text.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  textSha256?: string;

  @ApiPropertyOptional({ description: 'Clinician-accepted advisory corrections to promote.', type: [AcceptedCorrectionProposal] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AcceptedCorrectionProposal)
  acceptedProposals?: AcceptedCorrectionProposal[];

  @ApiPropertyOptional({ description: 'Clinician rating of the endpoint output, 1..5.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: 'Free-text clinician comment.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @ApiPropertyOptional({ description: 'Acting user, when one is known.' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Originating harness job, for correlation.' })
  @IsOptional()
  @IsString()
  jobId?: string;
}
