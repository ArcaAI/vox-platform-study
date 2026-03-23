import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenResponse {
    @ApiProperty({ description: 'New JWT access token' })
    token!: string;

    @ApiProperty({ description: 'New refresh token' })
    refreshToken!: string;
}
