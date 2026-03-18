import { IsEnum, IsJSON, IsOptional } from 'class-validator';
import { EntityIdProperty } from '../../../decorators';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ApiProperty } from '@nestjs/swagger';
import {
    ResourceSubscriptionType,
    ResourceType,
    JsonValue
} from '@arcaai/domains';

export class ResourceSubscriptionResponse extends BaseResponse {
    @ApiProperty({ description: 'ID of the resource', required: false })
    @EntityIdProperty()
    resourceId?: string;

    @ApiProperty({ description: 'Type name of the resource', required: false })
    @IsEnum(ResourceType)
    resourceTypeName?: ResourceType;

    @ApiProperty({ description: 'Type of subscription' })
    @IsEnum(ResourceSubscriptionType)
    subscriptionType!: ResourceSubscriptionType;

    @ApiProperty({ description: 'ID of the target user' })
    @EntityIdProperty()
    targetUserId!: string;

    @ApiProperty({
        description: 'Metadata for the subscription',
        required: false
    })
    @IsOptional()
    @IsJSON()
    subscriptionMetadata?: JsonValue;

    constructor(init: ResourceSubscriptionResponse & BaseResponseProps) {
        super(init);
        this.resourceId = init.resourceId;
        this.resourceTypeName = init.resourceTypeName;
        this.subscriptionType = init.subscriptionType;
        this.targetUserId = init.targetUserId;
        this.subscriptionMetadata = init.subscriptionMetadata;
    }
}
