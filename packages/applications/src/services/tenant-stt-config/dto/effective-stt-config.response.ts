import { ApiProperty } from '@nestjs/swagger';

/**
 * The RESOLVED STT fallback spec for a tenant (tenant row merged over the SYSTEM
 * default). This is what the gateway reads to decide the session's fallback
 * pipeline + auto-switch behaviour; every field is concrete.
 */
export class EffectiveSttConfigResponse {
  @ApiProperty({ description: 'Tenant the config was resolved for' })
  tenantId!: string;

  @ApiProperty({ description: 'Effective fallback pipeline id (null = no fallback configured)', nullable: true })
  fallbackPipelineId!: string | null;

  @ApiProperty({ description: 'Whether the error-triggered auto-switch is enabled' })
  autoSwitchEnabled!: boolean;

  @ApiProperty({ description: 'Consecutive utterance failures before an auto-switch' })
  consecutiveFailureThreshold!: number;
}
