import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { BaseRequest } from '../../../common';
import { JsonValue } from '@arcaai/domains';

export class UpdateWebhookRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the webhook', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'URL of the webhook endpoint',
    required: false,
  })
  @IsString()
  @IsOptional()
  url?: string;

  @ApiProperty({
    description: 'Hashed secret for webhook authentication',
    required: false,
  })
  @IsString()
  @IsOptional()
  hashedSecret?: string;

  @ApiProperty({ description: 'Resource type name', required: false })
  @IsString()
  @IsOptional()
  resourceTypeName?: string;

  @ApiProperty({ description: 'Resource ID', required: false })
  @IsString()
  @IsOptional()
  resourceId?: string;

  @ApiProperty({ description: 'Subscription metadata', required: false })
  @IsObject()
  @IsOptional()
  subscriptionMetadata?: JsonValue;

  // Required CAS predicate (echoed from
  // the prior GET). The controller (when one is wired) folds the
  // `If-Match` header value over this when both are present; missing
  // both yields `428 Precondition Required` on `@RequiresIfMatch()`
  // routes.
  @ApiProperty({
    description:
      'Current version of the row (from the prior GET, e.g. via the `ETag` header). The PATCH fails with `412 Precondition Failed` if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
