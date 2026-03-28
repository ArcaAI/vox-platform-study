import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class LogoutResponse {
  @ApiProperty({
    description: 'Indicates if logout was successful',
    example: true,
  })
  @IsBoolean()
  success: boolean;

  @ApiProperty({
    description: 'Optional message about the logout operation',
    example: 'Successfully logged out',
    required: false,
  })
  message?: string;
}
