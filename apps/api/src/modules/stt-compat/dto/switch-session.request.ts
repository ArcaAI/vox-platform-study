import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

/**
 * v1-compatible mid-session engine switch request (TASK-586 C3).
 *
 * The compat vocabulary is `pipeline`/`default`; the newer bidirectional
 * vocabulary is `primary`/`fallback`. Both are accepted and normalized:
 *   - `pipeline` ≡ `primary`  — the SDK-configured session pipeline
 *   - `default`  ≡ `fallback` — the tenant's configured default provider
 */
export class SwitchSessionRequest {
  @ApiProperty({
    description: 'Session identifier to switch',
    example: 'session_123456789',
  })
  @IsString()
  session_id: string;

  @ApiProperty({
    description: 'Target engine. `pipeline`/`primary` = the SDK-configured session pipeline; `default`/`fallback` = the tenant default provider.',
    example: 'default',
    enum: ['pipeline', 'default', 'primary', 'fallback'],
  })
  @IsIn(['pipeline', 'default', 'primary', 'fallback'])
  target: 'pipeline' | 'default' | 'primary' | 'fallback';
}
