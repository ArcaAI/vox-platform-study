import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PaginatedQuery } from '@arcaai/applications';
import type { UserExportFormat } from '../user-export.service';

/**
 * `?ids=a,b` (or a repeated `?ids=a&ids=b`) -> `['a','b']`; an empty selection
 * is `undefined` ("no id scope"), never `[]` — an empty array would otherwise
 * read as "export the empty set". Mirrors `parseTagsQuery` in
 * `prompt-management.controller.ts`, the house shape for a list-valued query
 * param (the gateway query string carries scalars only).
 */
function parseIdsQuery(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const ids = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Query for `GET /admin/users/export`. Extends the shared `PaginatedQuery` so
 * the export honours the SAME CSV filters/sort/search as the Users list;
 * `format` selects the serialization (defaults to `csv`).
 */
export class ExportUsersQuery extends PaginatedQuery {
  @ApiPropertyOptional({ description: 'Export format', enum: ['csv', 'xlsx', 'pdf'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'pdf'])
  format?: UserExportFormat;

  /**
   * Scope the export to ONE tenant. Backs the users list's in-page
   * tenant filter (users have no `tenantId` column, so the CSV filter grammar
   * cannot express the membership join). Guarded by the same
   * `assertCanReadTenant` as the by-tenant list route: SUPER_ADMIN may pass
   * any tenant, everyone else only their own CLS tenant.
   */
  @ApiPropertyOptional({ description: 'Scope the export to one tenant (membership-based; SUPER_ADMIN may pass any tenant)' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  /**
   * Scope the export to an explicit SELECTION of users — the console's
   * "Export selected (N)" action. NARROWS the tenant-scoped set the export
   * already reads; it never becomes a by-id fetch, so naming an id can only
   * ever remove rows from the result, never reach one outside the caller's
   * scope (see `collectExportRows`).
   *
   * The shape constraint is not decoration: the id set is composed into an
   * `id[in]:…` token of the CSV filter grammar, whose separators are
   * `;` `|` `[` `]:`. Pinning every item to hex-and-hyphens makes a
   * filter-injection token unrepresentable at the edge rather than relying on
   * the grammar to be hostile-input-safe. `ArrayMaxSize` matches the export
   * row cap.
   *
   * It is deliberately a SHAPE match and not `@IsUUID`, which enforces the
   * version nibble: this platform's reserved rows are not version-compliant
   * uuids (`60000000-…` the system user, `70000000-…` every seeded account),
   * so `@IsUUID('all')` answered `400 each value in ids must be a UUID` for a
   * selection containing any of them — "Export selected" worked for runtime
   * uuidv7 rows and failed for every seeded one. Pinned by
   * `__tests__/export-users.query.task986.test.ts`.
   */
  @ApiPropertyOptional({
    description: 'Export only these user ids (comma-separated, or repeated). Narrows the tenant-scoped set; it never widens it.',
    type: [String],
    example: ['0197f1e6-5b8e-7a1c-9c3d-2b6f0a1d4e55'],
  })
  @IsOptional()
  @Transform(({ value }) => parseIdsQuery(value))
  @IsArray()
  @ArrayMaxSize(10000)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    each: true,
    message: 'each value in ids must be a uuid-shaped id (hex and hyphens only)',
  })
  ids?: string[];
}
