import { ApiProperty } from '@nestjs/swagger';
import type { ApiKeyScopePresetKey } from '@arcaai/types';

export class ApiKeyScopeCatalogEntryResponse {
  @ApiProperty({ description: 'The grantable scope string' })
  readonly scope: string;

  @ApiProperty({ description: 'Human-readable description of what the scope grants' })
  readonly description: string;
}

export class ApiKeyScopePresetResponse {
  @ApiProperty({ description: 'The preset identifier, used as the value of the "Purpose" radio card' })
  readonly key: ApiKeyScopePresetKey;

  @ApiProperty({ description: 'Short label shown on the "Purpose" radio card' })
  readonly label: string;

  @ApiProperty({ description: 'One-sentence explanation of who this preset is for' })
  readonly description: string;

  @ApiProperty({ description: 'The scopes this preset grants', type: [String] })
  readonly scopes: string[];
}

export class ApiKeyScopesCatalogResponse {
  @ApiProperty({
    description: 'Every grantable scope, grouped by category',
    type: 'object',
    additionalProperties: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyScopeCatalogEntryResponse' } },
  })
  readonly categories: Record<string, ApiKeyScopeCatalogEntryResponse[]>;

  @ApiProperty({ description: 'The three scope presets the create-key dialog offers before "Custom"', type: [ApiKeyScopePresetResponse] })
  readonly presets: ApiKeyScopePresetResponse[];
}
