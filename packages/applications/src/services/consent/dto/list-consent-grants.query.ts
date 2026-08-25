import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ConsentPurpose } from '@arcaai/domains';
import { PaginatedQuery } from '../../../common';

/**
 * Lifecycle filter for the consent register (TASK-805).
 *
 * Deliberately NOT `resourceStatus` — a consent grant's meaningful lifecycle
 * lives in `revokedAt`/`expiresAt`, not in the soft-delete column. `ACTIVE`
 * is the same predicate `ConsultationConsentService.checkConsent` evaluates
 * (`ConsentGrantEntity.isActive`), so what the register labels "Active" is
 * exactly what the ABAC choke point would allow at that instant.
 */
export enum ConsentGrantState {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
  ALL = 'ALL',
}

export class ListConsentGrantsQuery extends PaginatedQuery {
  @ApiPropertyOptional({
    description: 'Filter to one patient. Trim-normalized on lookup, exact-case (Q3) — same normalization the write path applies.',
    example: 'EHR-A:12345',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalPatientId?: string;

  @ApiPropertyOptional({ description: 'Filter to one purpose-of-use', enum: ConsentPurpose })
  @IsOptional()
  @IsEnum(ConsentPurpose)
  purpose?: ConsentPurpose;

  @ApiPropertyOptional({
    description: 'Lifecycle filter. ACTIVE = not revoked and not expired (what the ABAC gate would allow now); REVOKED = revoked only; ALL = both.',
    enum: ConsentGrantState,
    default: ConsentGrantState.ALL,
  })
  @IsOptional()
  @IsEnum(ConsentGrantState)
  state?: ConsentGrantState = ConsentGrantState.ALL;
}
