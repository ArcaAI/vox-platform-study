import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class InitCheckpointUploadRequest {
  @ApiProperty({ description: 'Name of the .hcp file being uploaded; becomes the checkpoint label', example: 'acme-20261001-1200-0a1b2c3d.hcp', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ description: 'Size of the file in bytes; bounded by the tenant upload size limit', example: 734003200, minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
