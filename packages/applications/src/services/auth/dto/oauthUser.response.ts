import { IsString, IsArray, IsOptional } from 'class-validator';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ApiProperty } from '@nestjs/swagger';

export class OAuthUserResponse extends BaseResponse {
  @ApiProperty()
  @IsString()
  @IsOptional()
  firstName?: string | null;

  @ApiProperty()
  @IsString()
  @IsOptional()
  lastName?: string | null;

  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  phone?: string | null;

  @ApiProperty()
  @IsArray()
  roles!: string[];

  @ApiProperty()
  @IsArray()
  groups!: string[];

  @ApiProperty()
  @IsString()
  token?: string | null;

  constructor(init: OAuthUserResponse & BaseResponseProps) {
    super(init);
    this.firstName = init.firstName;
    this.lastName = init.lastName;
    this.email = init.email;
    this.phone = init.phone;
    this.roles = init.roles;
    this.groups = init.groups;
    this.token = init.token;
  }
}
