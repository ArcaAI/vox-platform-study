import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject } from 'class-validator';
import { BaseRequest } from '../../../common';
import { JsonValue } from '@arcaai/domains';

export class CreateWebhookRequest extends BaseRequest {
    @ApiProperty({ description: 'Name of the webhook' })
    @IsString()
    name!: string;

    @ApiProperty({ description: 'URL of the webhook endpoint' })
    @IsString()
    url!: string;

    @ApiProperty({
        description: 'Hashed secret for webhook authentication',
        required: false
    })
    @IsString()
    @IsOptional()
    hashedSecret?: string;

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
