import { Type } from 'class-transformer';
import { IsString, IsOptional, IsIn, IsBoolean, MaxLength, Matches, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The five typed shapes a declared prompt variable may take (TASK-890 §3.6). */
export const PROMPT_VARIABLE_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;
export type PromptVariableType = (typeof PROMPT_VARIABLE_TYPES)[number];

/**
 * Where a declared variable's VALUE comes from at run time — informational
 * metadata for the console's "derive from content" / binding UI. Never
 * consulted by the renderer itself (`renderTemplate` resolves the SCOPE the
 * caller builds; this only documents where a caller SHOULD source a value).
 */
export class PromptVariableSourceDto {
  @ApiProperty({ description: 'Where this variable is sourced from', enum: ['context', 'static'] })
  @IsIn(['context', 'static'] as const)
  kind: 'context' | 'static';

  @ApiPropertyOptional({ description: 'Dotted path into the consultation-context scope, when kind=context', example: 'context.patientAge' })
  @IsOptional()
  @IsString()
  path?: string;
}

/**
 * A typed prompt-variable declaration (TASK-890 §3.6, OD-K).
 *
 * `PromptTemplate.variables` / `PromptVersion.variables` (`Json?`) now store an
 * ARRAY of these — replacing the pre-TASK-890 legacy shape (a plain
 * `{ [name]: { type, required } }` map). There is NO read-side normaliser for
 * the legacy map (OD-K): the seeds are converted outright and a template
 * created/updated through this DTO can only ever produce the array shape.
 */
export class PromptVariableDeclarationDto {
  @ApiProperty({ description: 'Variable name — a bare identifier referenced in the template as `{{name}}`', example: 'patientAge' })
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: 'name must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*)' })
  name: string;

  @ApiProperty({ description: 'The value shape this variable carries', enum: PROMPT_VARIABLE_TYPES })
  @IsIn(PROMPT_VARIABLE_TYPES)
  type: PromptVariableType;

  @ApiProperty({ description: 'Whether a test run / invocation must supply a value when no default is declared' })
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional({ description: 'Default value (as a string; coerced to `type` at render time) used when the caller supplies none' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  default?: string;

  @ApiPropertyOptional({ description: 'Human-readable description shown in the console variables editor' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Where this variable is expected to be sourced from (informational)', type: PromptVariableSourceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PromptVariableSourceDto)
  source?: PromptVariableSourceDto;
}

/**
 * Parse a `PromptTemplate` / `PromptVersion` `variables` JSON column into the
 * typed declaration array. Array-only (OD-K: no legacy-map fallback) — any
 * other shape (including the retired `{ [name]: {...} }` map, `null`,
 * `undefined`) is treated as "no declarations" rather than reinterpreted.
 */
export function parsePromptVariableDeclarations(raw: unknown): PromptVariableDeclarationDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => typeof entry.name === 'string' && entry.name.length > 0)
    .map((entry) => {
      const decl = new PromptVariableDeclarationDto();
      decl.name = entry.name as string;
      decl.type = (PROMPT_VARIABLE_TYPES as readonly string[]).includes(entry.type as string) ? (entry.type as PromptVariableType) : 'string';
      decl.required = entry.required === true;
      if (typeof entry.default === 'string') decl.default = entry.default;
      if (typeof entry.description === 'string') decl.description = entry.description;
      if (entry.source && typeof entry.source === 'object') {
        const source = entry.source as Record<string, unknown>;
        if (source.kind === 'context' || source.kind === 'static') {
          const src = new PromptVariableSourceDto();
          src.kind = source.kind;
          if (typeof source.path === 'string') src.path = source.path;
          decl.source = src;
        }
      }
      return decl;
    });
}
