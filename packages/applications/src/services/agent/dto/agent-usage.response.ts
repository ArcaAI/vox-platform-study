import { ApiProperty } from '@nestjs/swagger';

/** TASK-1036 OD-21 — one published workflow version that pins the queried agent version. */
export class AgentUsageWorkflowResponse {
  @ApiProperty({ description: 'The workflow lineage slug.', example: 'general-medicine-intake' })
  slug: string;

  @ApiProperty({ description: 'The workflow version number.', example: 4 })
  versionNumber: number;

  @ApiProperty({ description: 'Whether this workflow version is the ACTIVE one of its slug.', example: true })
  isActive: boolean;
}

/** TASK-1036 OD-21 — `GET admin/agents/:slug/versions/:versionNumber/usage`. */
export class AgentUsageResponse {
  @ApiProperty({
    type: [AgentUsageWorkflowResponse],
    description: "The caller tenant's PUBLISHED or DEPRECATED workflow versions whose compiled config pins this agent version.",
  })
  publishedWorkflows: AgentUsageWorkflowResponse[];

  @ApiProperty({ description: 'Length of `publishedWorkflows` — the N in "used by N published workflows".', example: 2 })
  count: number;
}
