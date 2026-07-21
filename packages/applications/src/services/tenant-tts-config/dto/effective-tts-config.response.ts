import { ApiProperty } from '@nestjs/swagger';

/**
 * The RESOLVED TTS spec for a tenant (tenant row merged over the
 * SYSTEM default, clamped to platform limits). This is what the gateway injects
 * into tts-v2 per request; every field is concrete.
 */
export class EffectiveTtsConfigResponse {
  @ApiProperty({ description: 'Tenant the config was resolved for' })
  tenantId!: string;

  @ApiProperty({ description: 'Effective provider chain for en-*', type: [String] })
  routingEn!: string[];

  @ApiProperty({ description: 'Effective provider chain for ml-*', type: [String] })
  routingMl!: string[];

  @ApiProperty({ description: 'Effective provider whitelist', type: [String] })
  allowedProviders!: string[];

  @ApiProperty({ description: 'Effective default English voice id' })
  defaultVoiceEn!: string;

  @ApiProperty({ description: 'Effective default Malayalam voice id' })
  defaultVoiceMl!: string;

  @ApiProperty({ description: 'Effective default output format' })
  defaultFormat!: string;

  @ApiProperty({ description: 'Effective default speed' })
  defaultSpeed!: number;

  @ApiProperty({ description: 'Effective default sample rate (Hz)' })
  sampleRate!: number;

  @ApiProperty({ description: 'Effective max input characters' })
  maxInputChars!: number;

  @ApiProperty({ description: 'Whether routing to the Sarvam public API is allowed' })
  sarvamPublicApiAllowed!: boolean;

  // SYSTEM bindings merged under tenant bindings (per-voice-id
  // shallow merge, tenant wins). Injected into tts-v2 as `voice_bindings`.
  @ApiProperty({
    description: 'Effective per-voice provider voice-name bindings: { [internalVoiceId]: { [provider]: providerVoiceName } }',
    type: Object,
  })
  voiceBindings!: Record<string, Record<string, string>>;
}
