import {
  IConsultationService,
  ConsultationResponse,
  PaginatedConsultationResponse,
  PaginatedQuery,
  HttpMethod,
} from '@arcaai/applications';
import { Controller, Param, Inject, Query, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiEndpoint, CanManage } from '../../decorators';

/**
 * TASK-319 F1 — admin consultation surface (tenant-wide scope).
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
  async list(
    @Query() query: PaginatedQuery & { patientId?: string; doctorId?: string; departmentId?: string },
  ): Promise<PaginatedConsultationResponse> {
    return this.consultationService.listConsultationsForTenant({
      page: Number(query.page) || 1,
      pageSize: Number(query.limit) || 10,
      patientId: query.patientId,
      doctorId: query.doctorId,
      departmentId: query.departmentId,
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
