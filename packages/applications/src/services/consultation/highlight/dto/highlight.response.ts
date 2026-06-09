import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HighlightTargetKind } from '@arcaai/domains';

/**
 * Durable manual-doctor highlight (TASK-344 Workstream B).
 */
export class HighlightResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  consultationId: string;

  @ApiPropertyOptional({ description: 'The persisted ContextItem id this highlight is anchored to' })
  sourceContextItemId?: string;

  @ApiProperty({ enum: HighlightTargetKind })
  targetKind: HighlightTargetKind;

  @ApiProperty({ description: 'W3C TextQuoteSelector exact — the selected text span' })
  exact: string;

  @ApiPropertyOptional({ description: 'W3C TextQuoteSelector prefix' })
  prefix?: string;

  @ApiPropertyOptional({ description: 'W3C TextQuoteSelector suffix' })
  suffix?: string;

  @ApiProperty({ description: 'W3C TextPositionSelector start offset' })
  startOffset: number;

  @ApiProperty({ description: 'W3C TextPositionSelector end offset' })
  endOffset: number;

  @ApiPropertyOptional({ description: 'Presentation color' })
  color?: string;

  @ApiPropertyOptional({ description: 'Short label' })
  label?: string;

  @ApiPropertyOptional({ description: 'Free-form note' })
  note?: string;

  @ApiPropertyOptional({ description: 'User who authored the highlight' })
  createdBy?: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
