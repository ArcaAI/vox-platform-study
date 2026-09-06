import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional } from 'class-validator';
import { ModelTaskType } from '@arcaai/domains';
import type { ModelCatalogueFilter, ProviderGroup } from './model-catalogue.response';

/**
 * `GET admin/ai-models/catalogue` query string.
 *
 * Every field is DECLARED because the global pipe runs
 * `whitelist + forbidNonWhitelisted`: an undeclared parameter rejects the whole
 * request, so this class IS the accepted surface.
 */
export class ModelCatalogueQuery implements ModelCatalogueFilter {
  @ApiPropertyOptional({ description: 'Narrow to one task — the picker only ever shows one at a time.', enum: ModelTaskType })
  @IsOptional()
  @IsEnum(ModelTaskType)
  taskType?: ModelTaskType;

  @ApiPropertyOptional({ description: 'Narrow to one half of the picker.', enum: ['byo', 'hope'] })
  @IsOptional()
  @IsIn(['byo', 'hope'])
  providerGroup?: ProviderGroup;

  @ApiPropertyOptional({
    description: 'Hide models that cannot serve this tenant today. Off by default: an unusable model with a REASON is more useful than a gap.',
  })
  @IsOptional()
  // A query string carries text; `true`/`1` are the only truthy spellings so a
  // typo reads as `false` rather than silently hiding the catalogue.
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  usableOnly?: boolean;
}
