import { IsString, IsOptional, IsEnum, IsInt, Min, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HighlightTargetKind } from '@arcaai/domains';

// F-03: highlights fold verbatim into the harness prompt as `[highlight]`
// lines (`harness-internal.service.ts` assemble) — caps bound the
// prompt-injection / unbounded-payload surface (SOTA §5.1/§5.2).
export const HIGHLIGHT_TEXT_MAX_LENGTH = 10_000;

/**
 * Request to create a durable manual-doctor highlight on a persisted surface.
 * Anchored with W3C Web Annotation dual selectors: a TextQuoteSelector
 * (exact + optional prefix/suffix) AND a TextPositionSelector
 * (startOffset/endOffset).
 */
export class CreateHighlightRequest {
  @ApiProperty({ description: 'Which persisted surface this highlight anchors to', enum: HighlightTargetKind })
  @IsEnum(HighlightTargetKind)
  targetKind: HighlightTargetKind;

  @ApiProperty({ description: 'W3C TextQuoteSelector exact — the selected text span' })
  @IsString()
  @MaxLength(HIGHLIGHT_TEXT_MAX_LENGTH)
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
  @MaxLength(HIGHLIGHT_TEXT_MAX_LENGTH)
  note?: string;
}
