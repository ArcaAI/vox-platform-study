import { ApiProperty } from '@nestjs/swagger';
import { WebhookResponse } from '@arcaai/applications';

/**
 * TASK-727: the raw webhook signing secret is shown exactly once — at
 * creation (`POST admin/webhooks`) or rotation (`POST admin/webhooks/:id/rotate-secret`).
 * Mirrors `CreateApiKeyResponse` exactly.
 */
export class CreateWebhookResponse {
  @ApiProperty({ description: 'The created/rotated webhook details', type: () => WebhookResponse })
  webhook!: WebhookResponse;

  @ApiProperty({ description: 'The raw signing secret (shown only once)', example: 'a1b2c3...(64 hex chars)' })
  rawSecret!: string;
}
