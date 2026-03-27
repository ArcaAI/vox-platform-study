import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEmail } from 'class-validator';
import { BaseRequest } from '../../../../common';

// TODO: Implement this

export class CreateOAuthUserRequest extends BaseRequest {
  @ApiProperty({ description: 'The unique identifier for the user in the external system.' })
  @IsString()
  externalId!: string;

  @ApiProperty({ description: 'The email address of the user, if available.' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'The first name of the user, if available.' })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'The last name of the user, if available.' })
  @IsString()
  @IsOptional()
  lastName?: string;
}
