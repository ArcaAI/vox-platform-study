import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CreateSellRateRequest,
  ISellRateCardService,
  SellRateResponse,
  SellRateSupersedeResponse,
  SupersedeSellRateRequest,
} from '@arcaai/applications';
import { AiCapability, AiPriceRowKind, AiUsageUnit, TenantPlan } from '@arcaai/domains';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * SELL rate-card admin surface (D10/D12), mounted at
 * `/admin/billing/rate-card` (global prefix → `/api/v1/admin/billing/rate-card`).
 *
 * SUPERSEDE-ONLY: there is deliberately NO PATCH/PUT/DELETE here. A price is
 * repriced by superseding it (close + insert, atomic, If-Match OCC on the
 * close) — never edited in place, so a computed invoice stays reproducible.
 *
 * // AUTH-NOTE: mutation is SUPER_ADMIN-ONLY, enforced imperatively in
 * // `SellRateCardService` (`isSuperAdmin` → 403) — the decorator cannot
 * // express "super admins only" (rule 05). Class-level `@CanManage` keeps
 * // the deny-by-default boot audit green.
 */
@ApiBearerAuth()
@ApiTags('admin-billing-rate-card')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:billing:manage')
@Controller('admin/billing/rate-card')
@CanManage('AiPriceBook')
export class RateCardAdminController {
  constructor(@Inject(ISellRateCardService) private readonly sellRateCard: ISellRateCardService) {}

  @Get()
  @ApiOperation({
    summary: 'List SELL-plane rate rows (platform card by default; ?tenantId= for a negotiated tenant card). Includes superseded history rows.',
  })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'rowKind', required: false, enum: AiPriceRowKind })
  @ApiQuery({ name: 'capability', required: false, enum: AiCapability })
  @ApiQuery({ name: 'unit', required: false, enum: AiUsageUnit })
  @ApiQuery({ name: 'planTier', required: false, enum: TenantPlan })
  @ApiResponse({ status: 200, type: SellRateResponse, isArray: true })
  list(
    @Query('tenantId') tenantId?: string,
    @Query('rowKind') rowKind?: AiPriceRowKind,
    @Query('capability') capability?: AiCapability,
    @Query('unit') unit?: AiUsageUnit,
    @Query('planTier') planTier?: TenantPlan,
  ): Promise<SellRateResponse[]> {
    return this.sellRateCard.listSellRates({ tenantId, rowKind, capability, unit, planTier });
  }

  @Post()
  @ApiOperation({ summary: 'Create a new open-ended SELL rate row (overage rate or PLAN_FEE). SUPER_ADMIN only.' })
  @ApiResponse({ status: 201, type: SellRateResponse })
  create(@Body() request: CreateSellRateRequest): Promise<SellRateResponse> {
    return this.sellRateCard.createSellRate(request);
  }

  @Post(':id/supersede')
  @RequiresIfMatch()
  @ApiOperation({
    summary:
      "Supersede a rate row: close it at the successor's effectiveFrom and insert the successor — atomic, If-Match OCC on the close. SUPER_ADMIN only.",
    description:
      'Missing If-Match → 428; version drift → 412; an already-superseded row → 409-class business error. Dimensions are inherited — a supersede reprices, it never re-shapes.',
  })
  @ApiResponse({ status: 201, type: SellRateSupersedeResponse })
  supersede(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() request: SupersedeSellRateRequest,
    @ExpectedVersion() expectedVersion: number,
  ): Promise<SellRateSupersedeResponse> {
    return this.sellRateCard.supersedeSellRate(id, request, expectedVersion);
  }
}
