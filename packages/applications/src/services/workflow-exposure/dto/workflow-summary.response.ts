import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One entry of `GET /api/v1/workflows` — the tenant's published, invokable
 * workflows. Deliberately thin: no `inputSchema` field, because none is
 * declared anywhere in the substrate yet (see `InvokeWorkflowRequest`'s doc
 * comment for the same, fuller note).
 */
export class WorkflowSummaryResponse {
  @ApiProperty({ description: 'The public URL segment: /api/v1/workflows/:slug/…' })
  slug: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  paletteKey: string;

  @ApiProperty({ description: 'The ACTIVE published version number currently resolved for this slug.' })
  versionNumber: number;
}

export class WorkflowSummaryListResponse {
  @ApiProperty({ type: [WorkflowSummaryResponse] })
  data: WorkflowSummaryResponse[];
}
