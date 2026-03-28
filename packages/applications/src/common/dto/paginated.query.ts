import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class PaginatedQuery {
  @IsOptional()
  @ApiProperty({
    description: 'Page number (starting from 0)',
    example: 0,
    required: false,
    default: 0,
  })
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(0)
  page?: number;

  @IsOptional()
  @ApiProperty({
    description: 'Number of items per page (10, 20, or 50)',
    example: 10,
    required: false,
    default: 10,
  })
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @ApiProperty({
    description: 'Search query',
    required: false,
    default: '',
  })
  search?: string;

  @IsOptional()
  @ApiProperty({
    description: 'Search fields (comma separated: name,phoneNumber)',
    required: false,
    default: '',
  })
  searchFields?: string;

  @ApiProperty({
    description: 'Filters (comma separated: name:John,phoneNumber:123456)',
    required: false,
    default: '',
  })
  filters?: string;

  @ApiProperty({
    description: 'Sort (comma separated: name:asc,phoneNumber:desc)',
    required: false,
    default: '',
  })
  sort?: string;
}
