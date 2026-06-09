import { IsString, IsOptional, IsEnum, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HighlightTargetKind } from '@arcaai/domains';

/**
 * Request to create a durable manual-doctor highlight on a persisted surface
 * (TASK-344 Workstream B). Anchored with W3C Web Annotation dual selectors:
 * a TextQuoteSelector (exact + optional prefix/suffix) AND a TextPositionSelector
 * (startOffset/endOffset).
 */
export class CreateHighlightRequest {
  @ApiProperty({ description: 'Which persisted surface this highlight anchors to', enum: HighlightTargetKind })
  @IsEnum(HighlightTargetKind)
  targetKind: HighlightTargetKind;

  @ApiProperty({ description: 'W3C TextQuoteSelector exact — the selected text span' })
  @IsString()
  exact: string;

  @ApiProperty({ description: 'W3C TextPositionSelector start offset (>= 0)' })
  @IsInt()
  @Min(0)
  startOffset: number;

  @ApiProperty({ description: 'W3C TextPositionSelector end offset (>= startOffset)' })
  @IsInt()
  @Min(0)
  endOffset: number;

  @ApiPropertyOptional({ description: 'The persisted ContextItem id this highlight is anchored to' })
  @IsOptional()
  @IsString()
  sourceContextItemId?: string;

  @ApiPropertyOptional({ description: 'W3C TextQuoteSelector prefix (~32 chars before the span)' })
  @IsOptional()
  @IsString()
  prefix?: string;

  @ApiPropertyOptional({ description: 'W3C TextQuoteSelector suffix (~32 chars after the span)' })
  @IsOptional()
  @IsString()
  suffix?: string;

  @ApiPropertyOptional({ description: 'Presentation color (hex or token)' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ description: 'Short label for the highlight' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ description: 'Free-form note attached to the highlight' })
  @IsOptional()
  @IsString()
  note?: string;
}
