import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity } from '@arcaai/domains';

/**
 * Curated release note as seen by a caller (TASK-648 §3.5/§3.6, frozen
 * contract `ChangelogEntryResponse`).
 *
 * `body` is markdown and MUST be rendered sanitised by the consumer — it is
 * the one injection-shaped surface in this ticket.
 */
export class ChangelogEntryResponse {
  @ApiProperty({ description: 'Entry id (uuidv7)' })
  id!: string;

  @ApiProperty({ description: 'Platform train version this note belongs to, e.g. `2.1.0`' })
  platformVersion!: string;

  @ApiProperty({ description: 'Headline' })
  title!: string;

  @ApiProperty({ description: 'One line; what the popup shows collapsed' })
  summary!: string;

  @ApiProperty({ description: 'Markdown body. MUST be rendered sanitised.' })
  body!: string;

  @ApiProperty({ enum: ChangelogSeverity })
  severity!: ChangelogSeverity;

  @ApiProperty({ enum: ChangelogAudience })
  audience!: ChangelogAudience;

  @ApiProperty({ enum: ChangelogPublishStatus })
  publishStatus!: ChangelogPublishStatus;

  @ApiProperty({ type: String, nullable: true, description: 'ISO timestamp; null while DRAFT' })
  publishedAt!: string | null;

  @ApiPropertyOptional({ description: 'True when the calling user already has an acknowledgement row' })
  acknowledged?: boolean;

  @ApiProperty({
    description: 'Row version for optimistic concurrency. Echo back as `If-Match: "<version>"` on PATCH/publish.',
    example: 1,
  })
  version!: number;
}
