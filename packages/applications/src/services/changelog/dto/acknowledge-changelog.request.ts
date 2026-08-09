import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class AcknowledgeChangelogRequest {
  @ApiProperty({ type: [String], description: 'Entry ids the user has now seen' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  entryIds!: string[];
}
