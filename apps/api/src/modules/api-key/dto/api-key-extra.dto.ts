import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyResponse } from '@arcaai/applications';

export class CreateApiKeyResponse {
    @ApiProperty({ description: 'The created API key details', type: () => ApiKeyResponse })
    apiKey!: ApiKeyResponse;

    @ApiProperty({ description: 'The raw API key (shown only once)', example: 'ak_live_abc123...' })
    rawKey!: string;
}

export class ApiKeyUsageResponse {
    @ApiProperty({ description: 'Total number of API calls made' })
    totalCalls!: number;

    @ApiPropertyOptional({ description: 'Last time the API key was used', type: Date, nullable: true })
    lastUsedAt!: Date | null;

    @ApiProperty({ description: 'Rate limit for the API key' })
    rateLimit!: number;
}
