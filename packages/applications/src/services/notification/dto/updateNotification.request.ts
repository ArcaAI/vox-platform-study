import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsEnum } from 'class-validator';
import { BaseRequest } from '../../../common';
import { NotificationType } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';

export class UpdateNotificationRequest extends BaseRequest {
    @ApiProperty({ description: 'Title of the notification', required: false })
    @IsOptional()
    @IsString()
    title?: string;

    @ApiProperty({
        description: 'Message text of the notification',
        required: false
    })
    @IsOptional()
    @IsString()
    message?: string;

    @ApiProperty({
        description: 'Additional data for the notification',
        required: false
    })
    @IsOptional()
    data?: JsonValue;

    @ApiProperty({ description: 'Type of notification', required: false })
    @IsOptional()
    @IsEnum(NotificationType)
    type?: NotificationType;

    @ApiProperty({
        description: 'Read status of the notification',
        required: false
    })
    @IsOptional()
    @IsBoolean()
    read?: boolean;

    @ApiProperty({ description: 'Resource subscription ID', required: false })
    @IsOptional()
    @IsString()
    resourceSubscriptionId?: string;

    @ApiProperty({ description: 'Target user ID', required: false })
    @IsOptional()
    @IsString()
    targetUserId?: string;
}
