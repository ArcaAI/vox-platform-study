import { BadRequestException } from '@nestjs/common';

/**
 * Sortable fields for `GET /admin/consultations` (`AdminConsultationController#list`).
 * The single ALLOW-LIST both the gateway and the admin-console grid codec
 * (`apps/admin-console/src/shared/data/grid-url-state.ts` `serializeSort`/`parseSort`,
 * wire format `field:asc|desc`) agree on — anything else is a 400, never silently
 * ignored and never passed through to Prisma as an arbitrary `orderBy` key.
 */
export const CONSULTATION_SORTABLE_FIELDS = ['updatedAt', 'createdAt', 'appointmentDate', 'status'] as const;

export type ConsultationSortableField = (typeof CONSULTATION_SORTABLE_FIELDS)[number];

export interface ConsultationSort {
  field: ConsultationSortableField;
  direction: 'asc' | 'desc';
}

/** Default when `?sort` is absent: latest-updated first. */
export const DEFAULT_CONSULTATION_SORT: ConsultationSort = { field: 'updatedAt', direction: 'desc' };

const SORT_TOKEN_PATTERN = /^([A-Za-z]+):(asc|desc)$/;

/**
 * Parses the `?sort=field:asc|desc` query param.
 *
 * NOTE on WHY this is a plain function rather than a class-validator DTO:
 * `AdminConsultationController#list` takes its query as a hand-typed
 * intersection (`PaginatedQuery & { patientId?: string; ... }`), and an
 * intersection type collapses to `Object` for Nest's `design:paramtypes`
 * metadata — so the global `ValidationPipe`'s class-validator pass never
 * actually runs on that parameter (this is why the controller already
 * hand-parses `page`/`limit`/`status` instead of relying on the pipe). `sort`
 * follows the same house pattern as `status`'s `parseStatus`: validated
 * imperatively, right here, against `CONSULTATION_SORTABLE_FIELDS`.
 *
 * Returns `undefined` when `raw` is absent so the caller (the service) can
 * apply `DEFAULT_CONSULTATION_SORT`; throws `BadRequestException` for a
 * malformed token or a field outside the allow-list — never falls back
 * silently, and never reaches the repository unvalidated.
 */
export function parseConsultationSort(raw: string | undefined): ConsultationSort | undefined {
  if (!raw) return undefined;

  const match = SORT_TOKEN_PATTERN.exec(raw.trim());
  if (!match) {
    throw new BadRequestException(`Invalid sort "${raw}". Expected "field:asc" or "field:desc".`);
  }

  const [, field, direction] = match;
  if (!(CONSULTATION_SORTABLE_FIELDS as readonly string[]).includes(field)) {
    throw new BadRequestException(`Invalid sort field "${field}". Expected one of: ${CONSULTATION_SORTABLE_FIELDS.join(', ')}.`);
  }

  return { field: field as ConsultationSortableField, direction: direction as 'asc' | 'desc' };
}
