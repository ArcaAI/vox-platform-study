import { ApiProperty } from '@nestjs/swagger';

export class SsoStartResponse {
  @ApiProperty({ description: 'The tenant IdP authorize URL to redirect the browser to' })
  authorizeUrl!: string;
}
