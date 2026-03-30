import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class BulkDeleteUsersRequest {
  @ApiProperty({
    description: 'Array of user IDs to delete',
    type: [String],
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  ids!: string[];
}
