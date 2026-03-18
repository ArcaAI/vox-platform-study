import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EntityIdProperty } from '../../../decorators';

export class CheckAuthResponse {
    @EntityIdProperty()
    id: string;

    @ApiProperty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsString()
    lastName: string;

    @ApiProperty()
    @IsString()
    emailAddress: string;

    @ApiProperty()
    @IsString()
    phoneNumber: string | null;

    @ApiProperty()
    @IsString()
    token: string | null;

    constructor(init: CheckAuthResponse) {
        this.id = init.id;
        this.firstName = init.firstName;
        this.lastName = init.lastName;
        this.emailAddress = init.emailAddress;
        this.phoneNumber = init.phoneNumber;
        this.token = init.token;
    }
}
