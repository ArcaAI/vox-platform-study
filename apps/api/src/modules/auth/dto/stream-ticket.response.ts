import { ApiProperty } from '@nestjs/swagger';

/**
 * Response for `POST /auth/stream-ticket` (TASK-263 W0-1 / D1).
 */
export class IssueStreamTicketResponse {
  @ApiProperty({
    description: 'Single-use SSE auth ticket. Pass to the SSE endpoint as `?ticket=<ticket>`.',
    example: '5JjT2sx3y…',
  })
  ticket!: string;

  @ApiProperty({
    description: 'Epoch milliseconds at which this ticket expires (TTL = 30 seconds).',
    example: 1700000030000,
  })
  expiresAt!: number;

  @ApiProperty({
    description: 'Scope this ticket is bound to. Echoes the request scope so the SDK can sanity-check.',
    example: 'consultation_job:01HG7ZRXA3PJZ8QV0Y8N9Z6Q1S',
  })
  scope!: string;
}
