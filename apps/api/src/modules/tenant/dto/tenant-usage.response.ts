import { ApiProperty } from '@nestjs/swagger';

export class TenantUsageResponse {
  @ApiProperty({ description: 'Total number of users in the tenant' })
  totalUsers!: number;

  @ApiProperty({ description: 'Total number of departments' })
  totalDepartments!: number;

  @ApiProperty({ description: 'Total number of prompt templates' })
  totalPromptTemplates!: number;

  @ApiProperty({ description: 'Total number of pipelines' })
  totalPipelines!: number;
}
