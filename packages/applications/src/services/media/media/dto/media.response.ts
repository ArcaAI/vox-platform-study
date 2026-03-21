import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class MediaResponse extends BaseResponse {
    @ApiProperty({ description: 'Name of the media file' })
    name!: string;

    @ApiProperty({ description: 'URI/path to the media file' })
    uri!: string;

    @ApiProperty({ description: 'File extension' })
    extension!: string;

    @ApiProperty({ description: 'MIME type of the media file' })
    mimeType!: string;

    @ApiProperty({ description: 'Size of the file in bytes' })
    size!: number;

    @ApiProperty({ description: 'Hash of the file content' })
    hash!: string;

    constructor(init: MediaResponse & BaseResponseProps) {
        super(init);
        this.name = init.name;
        this.uri = init.uri;
        this.extension = init.extension;
        this.mimeType = init.mimeType;
        this.size = init.size;
        this.hash = init.hash;
    }
}
