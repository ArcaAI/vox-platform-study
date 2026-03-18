import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class UserMediaResponse extends BaseResponse {
    @ApiProperty({ description: 'ID of the user' })
    userId!: string;

    @ApiProperty({ description: 'ID of the media' })
    mediaId!: string;

    @ApiProperty({ description: 'Date when the media was shared', required: false })
    sharedAt?: Date;

    constructor(init: UserMediaResponse & BaseResponseProps) {
        super(init);
        this.userId = init.userId;
        this.mediaId = init.mediaId;
        this.sharedAt = init.sharedAt;
    }
}
