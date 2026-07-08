import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginatedQuery } from '../../../common/dto/paginated.query';

/**
 * TASK-443 — the settings LIST query: the generic paginated/filter contract
 * plus the bespoke `secretsOnly` facet. `isSecret` is DERIVED (encrypted value
 * OR `secrets` namespace OR convention-named key — see
 * `GlobalSettingDtoMapper.isSecretEntity`), not a column, so it cannot ride
 * the `filters` bracket grammar; this flag resolves the same tri-condition
 * server-side (`buildSecretSettingFilter`).
 */
export class ListGlobalSettingQuery extends PaginatedQuery {
  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Facet on the derived secret predicate: true returns only secret settings ' +
      '(encrypted, `secrets` namespace, or convention-named key), false only non-secrets; omit for all.',
    type: Boolean,
    example: true,
  })
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  secretsOnly?: boolean;
}
