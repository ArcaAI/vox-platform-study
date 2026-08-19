import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PipelinePolicyScope } from '@arcaai/domains';

export class WorkflowAssignmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ enum: PipelinePolicyScope }) scope!: PipelinePolicyScope;
  @ApiPropertyOptional({ nullable: true }) scopeId?: string | null;
  @ApiProperty() paletteKey!: string;
  @ApiProperty() workflowDefinitionSlug!: string;
  @ApiProperty({ description: 'ISO timestamp' }) createdAt!: string;
  @ApiProperty({ description: 'ISO timestamp' }) updatedAt!: string;
  /** `_version` — echo back via `If-Match: "<version>"` on the next write. */
  @ApiProperty() version!: number;
}
