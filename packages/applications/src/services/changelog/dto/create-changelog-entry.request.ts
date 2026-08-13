import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ChangelogAudience, ChangelogSeverity } from '@arcaai/domains';

/**
 * Create a release note. Always lands as `DRAFT` — the entry becomes visible
 * only through the explicit `publish` action (an auto-published
 * changelog is an unreviewed broadcast to every customer admin).
 */
export class CreateChangelogEntryRequest {
  @ApiProperty({ description: 'Platform train version, e.g. `2.1.0`. Unique across entries.' })
  @IsString()
  @IsNotEmpty()
  platformVersion!: string;

  @ApiProperty({ description: 'Headline' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ description: 'One-line summary shown collapsed in the popup' })
  @IsString()
  @IsNotEmpty()
  summary!: string;

  @ApiProperty({ description: 'Markdown body' })
  @IsString()
  @IsNotEmpty()
  body!: string;

  @ApiPropertyOptional({ enum: ChangelogSeverity, default: ChangelogSeverity.INFO })
  @IsOptional()
  @IsEnum(ChangelogSeverity)
  severity?: ChangelogSeverity;

  @ApiPropertyOptional({ enum: ChangelogAudience, default: ChangelogAudience.ALL })
  @IsOptional()
  @IsEnum(ChangelogAudience)
  audience?: ChangelogAudience;
}
