import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** `POST /auth/register/verify`. */
export class RegisterVerifyRequest {
  @ApiProperty({ description: 'Raw email-verification token from the emailed link' })
  @IsString()
  @IsNotEmpty()
  token!: string;
}
