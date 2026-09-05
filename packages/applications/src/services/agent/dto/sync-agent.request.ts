import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Push one agent version into other tenants the CALLER ALSO MANAGES (TASK-884, owner #4:
 * "a tenant admin who manages several tenants promotes/syncs among their OWN tenants").
 *
 * A target the caller does not hold `manage:Agent` in answers 404, not 403 — the tenant id space
 * is not the caller's to probe, so "you may not" and "there is no such tenant" must be
 * indistinguishable. (The Global → SYSTEM path is a different thing entirely: a super-admin
 * promotion, and a 403 there, because the caller is already entitled to know SYSTEM exists.)
 */
export class SyncAgentRequest {
  @ApiProperty({ description: 'The tenants to push this agent into. The caller must hold manage:Agent in every one of them.', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @IsString({ each: true })
  targetTenantIds!: string[];

  @ApiPropertyOptional({ description: 'Sync this exact version rather than the ACTIVE PUBLISHED one.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  sourceVersionNumber?: number;

  @ApiPropertyOptional({ description: 'Recorded on the sys-event for the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
