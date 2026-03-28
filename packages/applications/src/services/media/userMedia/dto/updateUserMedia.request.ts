import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsDate } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateUserMediaRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the user', required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ description: 'ID of the media', required: false })
  @IsOptional()
  @IsString()
  mediaId?: string;

  @ApiProperty({
    description: 'Date when the media was shared',
    required: false,
  })
  @IsOptional()
  @IsDate()
  sharedAt?: Date;
}
