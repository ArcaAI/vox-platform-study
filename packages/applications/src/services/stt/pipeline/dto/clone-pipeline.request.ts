import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Clone an existing pipeline into a new, editable copy.
 *
 * Deliberately NARROW: a clone takes only its own identity (`name` + `slug`)
 * and inherits everything else — config YAML, description, tags — from the
 * source. The caller customizes the copy afterwards through the normal PATCH
 * path, which is the whole point of cloning a locked template copy.
 *
 * `templateLocked` and `sourceTemplateSlug` are NOT accepted here (nor on any
 * other request DTO). The gateway's global pipe runs
 * `whitelist + forbidNonWhitelisted`, so an attempt to smuggle either field in
 * is rejected at the pipe rather than silently dropped — the lock cannot be
 * lifted, and provenance cannot be forged, over the API.
 */
export class ClonePipelineRequest {
  @ApiProperty({
    description: 'Name for the new copy',
    example: 'Whisper Large V3 Medical (our tuning)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'URL-friendly unique identifier for the new copy (unique within the tenant)',
    example: 'whisper-large-v3-medical-ours',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug: string;
}
