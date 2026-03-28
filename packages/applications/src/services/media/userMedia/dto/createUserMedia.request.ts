import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsDate } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserMediaRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the user' })
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'ID of the media' })
  @IsString()
  mediaId!: string;

  @ApiProperty({
    description: 'Date when the media was shared',
    required: false,
  })
  @IsOptional()
  @IsDate()
  sharedAt?: Date;
}
