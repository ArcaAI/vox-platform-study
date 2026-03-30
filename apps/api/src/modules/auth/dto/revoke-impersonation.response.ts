import { ApiProperty } from '@nestjs/swagger';

export class RevokeImpersonationResponse {
  @ApiProperty({ description: 'Whether the revocation was successful' })
  success!: boolean;
}
