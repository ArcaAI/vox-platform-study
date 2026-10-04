import { ApiProperty } from '@nestjs/swagger';

/** TASK-1036 R1 — one agent tag suggestion (`GET admin/agents/tags`), the prompt-tag mirror. */
export class AgentTagSuggestionResponse {
  @ApiProperty({ description: 'The tag, normalised to lower case.', example: 'dept:cardiology' })
  tag: string;

  @ApiProperty({ description: "How many of the tenant's agent LINEAGES (slugs) carry this tag.", example: 3 })
  count: number;
}
