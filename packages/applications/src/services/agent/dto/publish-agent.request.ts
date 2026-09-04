import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class PublishAgentRequest {
  @ApiPropertyOptional({
    description: 'Make this the ACTIVE version the resolver serves, demoting the slug’s previous active version (if any). Defaults to true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}
