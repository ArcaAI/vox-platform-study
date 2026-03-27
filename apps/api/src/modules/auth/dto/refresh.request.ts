import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenRequest {
  @ApiProperty({ description: 'The refresh token to exchange for a new access token', example: 'refresh_abc123_1234567890_hex...' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
