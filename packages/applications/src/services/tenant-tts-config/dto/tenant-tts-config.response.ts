import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The raw persisted TTS config row for a tenant (unresolved). */
export class TenantTtsConfigResponse {
  @ApiProperty({ description: 'Owning tenant id' })
  tenantId!: string;

  @ApiPropertyOptional({ description: 'Default English voice id', nullable: true })
  defaultVoiceEn?: string | null;

  @ApiPropertyOptional({ description: 'Default Malayalam voice id', nullable: true })
  defaultVoiceMl?: string | null;

  @ApiProperty({ description: 'Provider chain for en-*', type: [String] })
  routingEn!: string[];

  @ApiProperty({ description: 'Provider chain for ml-*', type: [String] })
  routingMl!: string[];

  @ApiProperty({ description: 'Provider whitelist', type: [String] })
  allowedProviders!: string[];

  @ApiPropertyOptional({ description: 'Default output format', nullable: true })
  defaultFormat?: string | null;

  @ApiPropertyOptional({ description: 'Default speed', nullable: true })
  defaultSpeed?: number | null;

  @ApiPropertyOptional({ description: 'Default sample rate (Hz)', nullable: true })
  sampleRate?: number | null;

  @ApiPropertyOptional({ description: 'Max input characters', nullable: true })
  maxInputChars?: number | null;

  @ApiProperty({ description: 'Whether routing to the Sarvam public API is allowed' })
  sarvamPublicApiAllowed!: boolean;

  // Carries voiceBindings (and any other task-specific extras).
  @ApiPropertyOptional({ description: 'Persisted config extras (incl. voiceBindings)', nullable: true, type: Object })
  configJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version. 0 when no row exists yet (create with expectedVersion=0).', example: 0 })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;
}
