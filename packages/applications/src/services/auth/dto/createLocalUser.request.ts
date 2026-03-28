import { IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateLocalUserRequest {
  @ApiProperty()
  @IsString()
  username!: string;

  @ApiProperty({
    description: 'Password must be at least 8 characters long and contain at least one uppercase letter, one digit, and one special character',
  })
  @IsString()
  @MinLength(8)
  @Matches(/.*[A-Z].*/, {
    message: 'Password must contain at least one uppercase character',
  })
  @Matches(/.*\d.*/, {
    message: 'Password must contain at least one digit',
  })
  @Matches(/.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?].*/, {
    message: 'Password must contain at least one special character',
  })
  password!: string;
}
