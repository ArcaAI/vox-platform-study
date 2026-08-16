import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject } from 'class-validator';
import { BaseRequest } from '../../../common';
import { JsonValue } from '@arcaai/domains';

// TASK-727: a caller may NEVER supply `hashedSecret` — mirrors
// `ApiKeyService.generateRawKey`. The signing secret is always
// server-generated at creation (see `WebhookService.create`) and returned
// exactly once in the response; a client-supplied value here would let a
// caller pin a weak/known secret or bypass peppered hashing entirely.
export class CreateWebhookRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the webhook' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'URL of the webhook endpoint' })
  @IsString()
  url!: string;

  @ApiProperty({ description: 'Resource type name' })
  @IsString()
  resourceTypeName!: string;

  @ApiProperty({ description: 'Resource ID', required: false })
  @IsString()
  @IsOptional()
  resourceId?: string;

  @ApiProperty({ description: 'Subscription metadata', required: false })
  @IsObject()
  @IsOptional()
  subscriptionMetadata?: JsonValue;
}
