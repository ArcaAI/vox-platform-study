import { ApiProperty } from '@nestjs/swagger';

/** Result of an ephemeral provider "Test connection" probe. Never carries the key. */
export class TestProviderConnectionResponse {
  @ApiProperty({ description: 'Whether the probe succeeded' })
  ok!: boolean;

  @ApiProperty({ description: 'Human-readable probe result' })
  message!: string;

  @ApiProperty({
    description:
      '`auth` — the provider confirmed the credential (a real auth-only call). `reachability` — the endpoint answered but ' +
      'the provider exposes no auth-only route, so the key is verified on first real use.',
    enum: ['auth', 'reachability'],
  })
  probe!: 'auth' | 'reachability';

  @ApiProperty({ description: 'Which tier supplied the probed configuration: the request body, the tenant row, or the SYSTEM row.', enum: ['request', 'tenant', 'platform'] })
  source!: 'request' | 'tenant' | 'platform';
}
