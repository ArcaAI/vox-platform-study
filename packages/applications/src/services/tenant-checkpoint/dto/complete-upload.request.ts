import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsString, Max, Min, ValidateNested } from 'class-validator';

export class CompletedUploadPart {
  @ApiProperty({ description: 'One-based part number', example: 1, minimum: 1, maximum: 10000 })
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber!: number;

  @ApiProperty({ description: 'The ETag response header the object store returned for this part', example: '"9b2cf535f27731c974343645a3985328"' })
  @IsString()
  @IsNotEmpty()
  etag!: string;
}

export class CompleteCheckpointUploadRequest {
  @ApiProperty({ type: [CompletedUploadPart], description: 'Every uploaded part, ascending by part number with no gaps' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => CompletedUploadPart)
  parts!: CompletedUploadPart[];
}
