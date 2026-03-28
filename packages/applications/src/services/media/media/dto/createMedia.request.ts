import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateMediaRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the media file' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'URI/path to the media file' })
  @IsString()
  uri!: string;

  @ApiProperty({ description: 'File extension' })
  @IsString()
  extension!: string;

  @ApiProperty({ description: 'MIME type of the media file' })
  @IsString()
  mimeType!: string;

  @ApiProperty({ description: 'Size of the file in bytes' })
  @IsNumber()
  size!: number;

  @ApiProperty({ description: 'Hash of the file content' })
  @IsString()
  hash!: string;
}
