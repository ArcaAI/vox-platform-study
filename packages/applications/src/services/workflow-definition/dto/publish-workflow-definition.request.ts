import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class PublishWorkflowDefinitionRequest {
  @ApiPropertyOptional({
    description:
      'Make this the ACTIVE version the dispatcher resolves for new runs, demoting the slug’s previous active ' +
      'version (if any). Defaults to true — a publish with no reason to stay inactive should serve immediately.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}
