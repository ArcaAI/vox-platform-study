import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProviderReconciliationRunEntity } from '@arcaai/domains';

/**
 * One provider-reconciliation attempt, as read by the audit report
 * (rule 6).
 *
 * Quantities ride as STRINGS, like every other number on this plane: these are
 * Decimal(38,6) columns and a JSON double would silently lose precision on a
 * large token total — the same rule the money surfaces follow.
 *
 * `null` is meaningful throughout and is NEVER coerced to 0: a skipped or
 * failed run genuinely has no comparison, and a 0 would read as "the vendor
 * billed nothing".
 */
export class ProviderReconciliationRunResponse {
  @ApiProperty() id!: string;
  @ApiProperty() provider!: string;

  @ApiProperty({ description: 'Human window label, e.g. "2026-08-06" or "2026-08-04..2026-08-06".' })
  window!: string;
  @ApiProperty() windowStart!: string;
  @ApiProperty({ description: 'EXCLUSIVE end of the half-open window.' }) windowEnd!: string;

  @ApiProperty({ enum: ['reconciled', 'skipped', 'failed'] })
  status!: string;
  @ApiPropertyOptional({ description: 'Why, when the status is not `reconciled` — availability reason or transport error.' })
  reason!: string | null;

  @ApiPropertyOptional({ description: "The ledger's own CLOUD-only total. Null when no comparison happened." })
  ledgerQuantity!: string | null;
  @ApiPropertyOptional({ description: "The vendor's reported total, in THEIR unit vocabulary." })
  providerQuantity!: string | null;
  @ApiPropertyOptional() providerUnit!: string | null;

  @ApiPropertyOptional({ description: 'Signed (provider - ledger) / ledger. Null when the ratio is undefined (ledger 0).' })
  relativeDrift!: string | null;
  @ApiProperty() breachedThreshold!: boolean;
  @ApiProperty({ description: 'The threshold in force FOR THIS RUN — stamped so a later change cannot reinterpret the verdict.' })
  thresholdPct!: number;

  @ApiProperty() runAt!: string;
}

export class ProviderReconciliationRunDtoMapper {
  static toResponse(entity: ProviderReconciliationRunEntity): ProviderReconciliationRunResponse {
    const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
    return {
      id: entity.id,
      provider: entity.provider,
      window: entity.windowLabel,
      windowStart: entity.windowStart.toISOString(),
      windowEnd: entity.windowEnd.toISOString(),
      status: entity.status,
      reason: entity.reason ?? null,
      ledgerQuantity: asString(entity.ledgerQuantity),
      providerQuantity: asString(entity.providerQuantity),
      providerUnit: entity.providerUnit ?? null,
      relativeDrift: asString(entity.relativeDrift),
      breachedThreshold: entity.breachedThreshold ?? false,
      thresholdPct: entity.thresholdPct,
      runAt: (entity.runAt ?? entity.createdAt).toISOString(),
    };
  }

  static toResponseList(entities: ProviderReconciliationRunEntity[]): ProviderReconciliationRunResponse[] {
    return entities.map((entity) => ProviderReconciliationRunDtoMapper.toResponse(entity));
  }
}
