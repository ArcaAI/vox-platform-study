import { ApiProperty } from '@nestjs/swagger';

/** Result of an ephemeral BYO-provider "Test connection" probe. Never carries the key. */
export class TestSttCredentialResponse {
  @ApiProperty({ description: 'Whether the probe succeeded' })
  ok!: boolean;

  @ApiProperty({ description: 'Human-readable probe result' })
  message!: string;
}
