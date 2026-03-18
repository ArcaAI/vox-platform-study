import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateMediaRequest extends BaseRequest {
    @ApiProperty({ description: 'Name of the media file', required: false })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiProperty({ description: 'URI/path to the media file', required: false })
    @IsString()
    @IsOptional()
    uri?: string;

    @ApiProperty({ description: 'File extension', required: false })
    @IsString()
    @IsOptional()
    extension?: string;

    @ApiProperty({
        description: 'MIME type of the media file',
        required: false
    })
    @IsString()
    @IsOptional()
    mimeType?: string;

    @ApiProperty({ description: 'Size of the file in bytes', required: false })
    @IsNumber()
    @IsOptional()
    size?: number;

    @ApiProperty({ description: 'Hash of the file content', required: false })
    @IsString()
    @IsOptional()
    hash?: string;
}
