import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  AddAdjustmentRequest,
  BillingInvoiceResponse,
  BillingInvoiceSummaryResponse,
  ComputeDraftRequest,
  IActiveUserContext,
  IBillingService,
  SpendStatusResponse,
} from '@arcaai/applications';
import { BillingInvoiceStatus } from '@arcaai/domains';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * Invoice admin surface (D13), mounted at
 * `/admin/billing/invoices` (global prefix → `/api/v1/admin/billing/invoices`).
 *
 * Lifecycle: compute-draft (idempotent recompute) → finalize (If-Match OCC,
 * immutable after) · void (DRAFT only) · adjustments (FINALIZED only — the
 * credit-memo correction path).
 *
 * Tenant scoping: `resolveScopedTenantId` — super admins act cross-tenant via
 * `?tenantId=`; a tenant-bound caller is pinned. Cross-tenant BY-ID access
 * returns 404 (never 403) from the service.
 *
 * // AUTH-NOTE: computeDraft / finalize / void / addAdjustment are
 * // SUPER_ADMIN-ONLY, enforced imperatively in `BillingService`
 * // (`isSuperAdmin` → 403) — rule 05. Class-level `@CanManage` keeps the
 * // deny-by-default boot audit green.
 *
 * Route-order note: the static `spend-status` path is declared BEFORE `:id`.
 */
@ApiBearerAuth()
@ApiTags('admin-billing-invoices')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:billing:manage')
@Controller('admin/billing/invoices')
@CanManage('BillingInvoice')
export class BillingAdminController {
  constructor(
    @Inject(IBillingService) private readonly billing: IBillingService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('spend-status')
  @ApiOperation({ summary: "Month-to-date SELL-rated overage spend vs the tenant's spend limit (D12)." })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin target tenant.' })
  @ApiQuery({ name: 'period', required: true, description: 'YYYY-MM (UTC calendar month).' })
  @ApiResponse({ status: 200, type: SpendStatusResponse })
  spendStatus(@Query('period') period: string, @Query('tenantId') tenantId?: string): Promise<SpendStatusResponse> {
    return this.billing.getSpendStatus(this.scopedTenantId(tenantId), period);
  }

  @Get()
  @ApiOperation({ summary: "One tenant's invoices, newest period first." })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: BillingInvoiceStatus })
  @ApiResponse({ status: 200, type: BillingInvoiceSummaryResponse, isArray: true })
  list(@Query('tenantId') tenantId?: string, @Query('status') status?: BillingInvoiceStatus): Promise<BillingInvoiceSummaryResponse[]> {
    return this.billing.listInvoices(this.scopedTenantId(tenantId), status);
  }

  @Post('compute-draft')
  @ApiOperation({
    summary: 'Compute — or idempotently recompute — the DRAFT invoice for one tenant-month. SUPER_ADMIN only.',
    description:
      'Reads daily rollups (never raw events), the PlanEntitlement←TenantEntitlement allowance chain and the SELL card. ' +
      "A recompute supersedes the draft's lines in one transaction. FINALIZED/VOID periods → 409. Incomplete rate card → 409 (fail-closed).",
  })
  @ApiResponse({ status: 201, type: BillingInvoiceResponse })
  computeDraft(@Body() request: ComputeDraftRequest): Promise<BillingInvoiceResponse> {
    return this.billing.computeDraft(request.tenantId, request.period);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Invoice read model: lines, memos against it, BYOK notional spend. Cross-tenant id → 404.' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, type: BillingInvoiceResponse })
  get(@Param('id', ParseUUIDPipe) id: string, @Query('tenantId') tenantId?: string): Promise<BillingInvoiceResponse> {
    return this.billing.getInvoice(this.scopedTenantId(tenantId), id);
  }

  @Post(':id/finalize')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'DRAFT → FINALIZED under If-Match OCC. Immutable after; only once the period has ended. SUPER_ADMIN only.',
    description: 'Missing If-Match → 428; version drift → 412; already finalized/void → 409; period still running → 400.',
  })
  @ApiResponse({ status: 201, type: BillingInvoiceResponse })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @ExpectedVersion() expectedVersion: number,
    @Query('tenantId') tenantId?: string,
  ): Promise<BillingInvoiceResponse> {
    return this.billing.finalize(this.scopedTenantId(tenantId), id, expectedVersion);
  }

  @Post(':id/void')
  @RequiresIfMatch()
  @ApiOperation({ summary: 'DRAFT → VOID under If-Match OCC (one-way; a voided period stays void). SUPER_ADMIN only.' })
  @ApiResponse({ status: 201, type: BillingInvoiceResponse })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @ExpectedVersion() expectedVersion: number,
    @Query('tenantId') tenantId?: string,
  ): Promise<BillingInvoiceResponse> {
    return this.billing.voidDraft(this.scopedTenantId(tenantId), id, expectedVersion);
  }

  @Post(':id/adjustments')
  @ApiOperation({
    summary: 'Issue a credit/debit memo against a FINALIZED invoice — the only correction path for a closed period. SUPER_ADMIN only.',
    description:
      'Never mutates lines or stored totals; the memo nets as an ADJUSTMENT line on the draft of the period it is issued in. DRAFT target → 409.',
  })
  @ApiResponse({ status: 201, type: BillingInvoiceResponse })
  addAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() request: AddAdjustmentRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<BillingInvoiceResponse> {
    return this.billing.addAdjustment(this.scopedTenantId(tenantId), id, request);
  }

  private scopedTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
