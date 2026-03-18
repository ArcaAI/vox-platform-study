import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class UserResponse extends BaseResponse {
    @ApiProperty({ description: 'Username of the user' })
    username!: string;

    @ApiProperty({ description: 'Last login timestamp', required: false })
    lastLoginAt?: Date;

    @ApiProperty({ description: 'Last active timestamp', required: false })
    lastActiveAt?: Date;

    @ApiProperty({ description: 'External identifier', required: false })
    externalId?: string;

    @ApiProperty({ description: 'Whether this is a service account' })
    isServiceAccount: boolean = false;

    @ApiProperty({ description: 'First secret key', required: false })
    secret1?: string;

    @ApiProperty({ description: 'First secret key expiry', required: false })
    secret1Expiry?: Date;

    @ApiProperty({ description: 'Second secret key', required: false })
    secret2?: string;

    @ApiProperty({ description: 'Second secret key expiry', required: false })
    secret2Expiry?: Date;

    constructor(init: UserResponse & BaseResponseProps) {
        super(init);
        this.username = init.username;
        this.lastLoginAt = init.lastLoginAt;
        this.lastActiveAt = init.lastActiveAt;
        this.externalId = init.externalId;
        this.isServiceAccount = init.isServiceAccount;
        this.secret1 = init.secret1;
        this.secret1Expiry = init.secret1Expiry;
        this.secret2 = init.secret2;
        this.secret2Expiry = init.secret2Expiry;
    }
}
