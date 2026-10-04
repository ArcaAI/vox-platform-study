import { ApiProperty } from '@nestjs/swagger';

/** TASK-1036 — one tag suggestion of `GET admin/workflow-definitions/tags`. */
export class WorkflowTagSuggestionResponse {
  @ApiProperty({ description: 'The tag, normalised to lower case.', example: 'cardiology' })
  tag: string;

  @ApiProperty({ description: "How many of the tenant's workflow lineages (slugs) carry this tag.", example: 3 })
  count: number;
}
