import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginatedQuery } from '../../../common/dto';

/**
 * The workflow-definition register's own filters, on top of `PaginatedQuery`.
 *
 * WHY A TYPED FIELD RATHER THAN THE GENERIC `filters` STRING. The inherited
 * `filters` param can already express this as `paletteKey[equals]:core`, and
 * that keeps working. But the generic grammar is `field[op]:value` with `;`
 * separators, and a token that does not match it is DROPPED — so the natural
 * guesses (`?paletteKey=core`, which the strict global pipe 400s, and
 * `filters=paletteKey:core`, which does not) left a caller asking for ONE
 * palette holding EVERY palette and no way to tell. A first-class field
 * removes the guess, and the service validates the value against the palettes
 * the node registry declares: a wrong key is a 400 naming the known ones,
 * never an empty page that reads as "this tenant has none".
 */
export class ListWorkflowDefinitionsQuery extends PaginatedQuery {
  @ApiPropertyOptional({
    description:
      'Filter to one palette. Validated against the palettes the node registry declares — an unknown key is a 400 listing the known ones, never an empty page.',
    example: 'core',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  paletteKey?: string;
}
