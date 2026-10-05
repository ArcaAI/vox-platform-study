import { ApiProperty } from '@nestjs/swagger';

/** One distinct tag over the caller tenant's prompts, with how many prompts carry it. */
export class PromptTagSuggestionResponse {
  @ApiProperty({ description: 'The tag, verbatim.', example: 'dept:cardiology' })
  tag: string;

  @ApiProperty({ description: "How many of the tenant's prompts carry this tag.", example: 3 })
  count: number;
}
