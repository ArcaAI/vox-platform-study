import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({
    description: 'Which tier supplied the probed configuration: the request body, the tenant row, or the SYSTEM row.',
    enum: ['request', 'tenant', 'platform'],
  })
  source!: 'request' | 'tenant' | 'platform';

  @ApiPropertyOptional({
    description:
      'Model / deployment ids the vendor listed during this probe (TASK-890 §3.7) — the input for "derive models from ' +
      'provider" in the models editor. ABSENT (never `[]`) when the vendor exposes no listing, the probe failed, or the ' +
      'response could not be parsed: an empty array would promise a list that was never obtained.',
    type: [String],
  })
  discoveredModels?: string[];
}
