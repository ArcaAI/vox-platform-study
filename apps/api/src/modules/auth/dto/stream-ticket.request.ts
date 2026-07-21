import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for `POST /auth/stream-ticket`.
 *
 * Format of `scope` is `<namespace>:<resourceId>`, e.g.
 * `consultation_job:01HG7Z…`. The guard on the target SSE route uses
 * `@StreamScope({ namespace, param })` to validate the scope against the
 * route params at consumption time.
 */
export class IssueStreamTicketRequest {
  @ApiProperty({
    description: 'Scope the ticket is bound to. Format: `<namespace>:<resourceId>`. Example: `consultation_job:01HG7ZRXA3PJZ…`.',
    example: 'consultation_job:01HG7ZRXA3PJZ8QV0Y8N9Z6Q1S',
  })
  @IsString()
  @IsNotEmpty()
  scope!: string;
}
