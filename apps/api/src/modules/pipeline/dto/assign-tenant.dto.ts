import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Request body for `POST /admin/audio/pipelines/:id/assign-tenant`.
 */
export class AssignTenantRequest {
  @ApiProperty({ description: 'Tenant ID to assign the pipeline to' })
  @IsString()
  @IsNotEmpty()
  tenantId!: string;
}

export class AssignTenantResponse {
  @ApiProperty({ description: 'Human-readable confirmation' })
  message!: string;

  @ApiProperty({ description: 'Pipeline ID' })
  pipelineId!: string;

  @ApiProperty({ description: 'Tenant the pipeline was assigned to' })
  tenantId!: string;
}
