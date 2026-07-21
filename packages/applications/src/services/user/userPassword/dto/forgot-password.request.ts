import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

/** Public self-service forgot-password request. */
export class ForgotPasswordRequest {
  @ApiProperty({ description: 'Email address of the account to reset', example: 'doctor@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
