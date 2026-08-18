import {
  IConsultationService,
  ConsultationResponse,
  ConsultationAggregateResponse,
  PaginatedConsultationResponse,
  PaginatedQuery,
  HttpMethod,
} from '@arcaai/applications';
import { ConsultationStatus } from '@arcaai/domains';
import { BadRequestException, Controller, Param, Inject, Query, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiEndpoint, CanManage, ForbidApiKey } from '../../decorators';

/**
 * Admin consultation surface (tenant-wide scope).
 *
 * Separate-controller (Pattern A) admin counterpart to {@link ConsultationController}.
 * Where the end-user controller scopes every list/read to the caller (own +
 * shared-patient consultations), this surface lists EVERY consultation in the
 * caller's tenant.
 *
 * Access:
 *   - Class-level `@CanManage('Consultation')` → only TENANT_ADMIN / SUPER_ADMIN.
 *     A plain DOCTOR holds only owner-scoped `list/read Consultation` (conditioned
 *     to `doctorId=self`), never `manage`, so the guard returns 403 for them.
 *
 * Tenant isolation:
 *   - The `tenantScopeFilter` Prisma extension injects `tenantId` into every read,
 *     so `getByIdWithRelations` nulls out a cross-tenant id → 404 (no existence
 *     leak). `Consultation` is not one of the `@TenantOwnedResource` model names
 *     (it has no gateway repository binding), so the extension is the enforcement
 *     point here.
 */
@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@Controller('admin/consultations')
@CanManage('Consultation')
export class AdminConsultationController {
  constructor(
    @Inject(IConsultationService)
    private readonly consultationService: IConsultationService,
  ) {}

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'patientId', required: false, type: String })
  @ApiQuery({ name: 'doctorId', required: false, type: String })
  @ApiQuery({ name: 'departmentId', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ConsultationStatus,
    description: 'Filter by lifecycle status (e.g. RECORDING for in-progress live sessions).',
  })
  async list(
    @Query() query: PaginatedQuery & { patientId?: string; doctorId?: string; departmentId?: string; status?: string },
  ): Promise<PaginatedConsultationResponse> {
    return this.consultationService.listConsultationsForTenant({
      page: Number(query.page) || 1,
      pageSize: Number(query.limit) || 10,
      patientId: query.patientId,
      doctorId: query.doctorId,
      departmentId: query.departmentId,
      status: this.parseStatus(query.status),
    });
  }

  /** Validate the optional `?status` query against the enum (avoids leaking a raw Prisma enum error). */
  private parseStatus(status?: string): ConsultationStatus | undefined {
    if (status === undefined || status === '') return undefined;
    if (!Object.values(ConsultationStatus).includes(status as ConsultationStatus)) {
      throw new BadRequestException(`Invalid status filter. Expected one of: ${Object.values(ConsultationStatus).join(', ')}.`);
    }
    return status as ConsultationStatus;
  }

  /**
   * Server-side, zero-filled new/revisit aggregation over a
   * date range. Scope follows the same model as `list`: a SUPER_ADMIN with
   * no working tenant aggregates cross-tenant; everyone else is pinned to their
   * CLS tenant. Declared BEFORE the `:id` route so `GET /aggregate` is not
   * captured by the `:id` param matcher.
   */
  @ApiEndpoint({
    returnedModel: ConsultationAggregateResponse,
    method: HttpMethod.GET,
    path: 'aggregate',
  })
  @ApiQuery({ name: 'from', required: true, type: String, description: 'Range start (ISO-8601 / yyyy-MM-dd).' })
  @ApiQuery({ name: 'to', required: true, type: String, description: 'Range end (ISO-8601 / yyyy-MM-dd).' })
  @ApiQuery({
    name: 'granularity',
    required: false,
    enum: ['day', 'month'],
    description: 'Force bucket granularity; defaults to day (month for >70-day spans).',
  })
  async aggregate(@Query() query: { from?: string; to?: string; granularity?: string }): Promise<ConsultationAggregateResponse> {
    if (!query.from || !query.to) {
      throw new BadRequestException('Both `from` and `to` query params are required.');
    }
    const granularity = query.granularity === 'day' || query.granularity === 'month' ? query.granularity : undefined;
    return this.consultationService.aggregateConsultationsForTenant({
      from: query.from,
      to: query.to,
      granularity,
    });
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.GET,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async getById(@Param('id') id: string): Promise<ConsultationResponse> {
    const result = await this.consultationService.getByIdWithRelations(id);
    if (!result) throw new NotFoundException(`Consultation ${id} not found`);
    return result;
  }
}
