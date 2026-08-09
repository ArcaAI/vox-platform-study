import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginatedQuery } from '../../../common';

export class ListReleasesQuery extends PaginatedQuery {
  @ApiPropertyOptional({ description: 'Filter to one service', example: 'smr' })
  @IsOptional()
  @IsString()
  serviceName?: string;

  @ApiPropertyOptional({ description: 'Only releases observed running in this environment', enum: ['dev', 'staging', 'prod'] })
  @IsOptional()
  @IsIn(['dev', 'staging', 'prod'])
  environment?: string;
}
