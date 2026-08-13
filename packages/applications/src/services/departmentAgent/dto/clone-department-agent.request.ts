import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Clone a department agent into a new, editable copy ("clone to customize").
 *
 * Mirrors `ClonePipelineRequest`: deliberately NARROW — the clone
 * takes only its own identity (`name` + `slug`) and inherits everything else
 * (bound-template content, DNA policy, harness overrides, description, tags)
 * from the source. The caller customizes the copy afterwards through the normal
 * PATCH path, which is the whole point of cloning a LOCKED template copy.
 *
 * `templateLocked` and `sourceAgentTemplateSlug` are NOT accepted here (nor on
 * any request DTO). The gateway's global pipe runs
 * `whitelist + forbidNonWhitelisted`, so an attempt to smuggle either field is
 * rejected at the pipe — the lock cannot be lifted, nor provenance forged, over
 * the API.
 */
export class CloneDepartmentAgentRequest {
  @ApiProperty({ description: 'Name for the new editable copy', example: 'Cardiology SOAP (our tuning)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'URL-friendly slug for the new copy (unique within the department)',
    example: 'cardiology-soap-ours',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug!: string;
}
