import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class UserProfileResponse extends BaseResponse {
    @ApiProperty({ description: 'First name of the user', required: false })
    firstName?: string;

    @ApiProperty({ description: 'Last name of the user', required: false })
    lastName?: string;

    @ApiProperty({ description: 'Email address', required: false })
    email?: string;

    @ApiProperty({ description: 'Phone number', required: false })
    phone?: string;

    @ApiProperty({ description: 'Avatar media ID', required: false })
    avatarId?: string;

    @ApiProperty({ description: 'ID of the associated user' })
    userId!: string;

    constructor(init: UserProfileResponse & BaseResponseProps) {
        super(init);
        this.firstName = init.firstName;
        this.lastName = init.lastName;
        this.email = init.email;
        this.phone = init.phone;
        this.avatarId = init.avatarId;
        this.userId = init.userId;
    }
}
