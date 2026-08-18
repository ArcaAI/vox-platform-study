import { BadRequestException, Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  BillingInvoiceResponse,
  BillingInvoiceSummaryResponse,
  IActiveUserContext,
  IBillingService,
  SpendStatusResponse,
  periodOf,
} from '@arcaai/applications';
import { Authorize, ForbidApiKey } from '../../decorators';

/**
 * Tenant self-service billing reads (D8/D12), mounted at
 * `/billing/me/*` (global prefix → `/api/v1/billing/me/*`).
 *
 * Gated with `read Tenant` — the same posture as `/entitlements/me`: a tenant
 * user sees ONLY their own tenant's invoices and spend. A foreign invoice id
 * reads as 404 (never 403). Super Admins use `/admin/billing/*`, not here.
 *
 * READ-ONLY by construction: no mutation route exists on this controller.
 */
@ApiBearerAuth()
@ApiTags('billing')
@Controller('billing')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: self-service billing reads.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class MyBillingController {
  constructor(
    @Inject(IBillingService) private readonly billing: IBillingService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('me/invoices')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: "The caller's own tenant's invoices, newest period first." })
  @ApiResponse({ status: 200, type: BillingInvoiceSummaryResponse, isArray: true })
  listMine(): Promise<BillingInvoiceSummaryResponse[]> {
    return this.billing.listInvoices(this.ownTenantId());
  }

  @Get('me/invoices/:id')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: 'One of my invoices (lines, memos, BYOK notional spend). A foreign id → 404.' })
  @ApiResponse({ status: 200, type: BillingInvoiceResponse })
  getMine(@Param('id', ParseUUIDPipe) id: string): Promise<BillingInvoiceResponse> {
    return this.billing.getInvoice(this.ownTenantId(), id);
  }

  @Get('me/spend')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: 'Month-to-date usage-and-spend snapshot vs my spend limit. Defaults to the current period.' })
  @ApiQuery({ name: 'period', required: false, description: 'YYYY-MM; defaults to the current UTC month.' })
  @ApiResponse({ status: 200, type: SpendStatusResponse })
  spend(@Query('period') period?: string): Promise<SpendStatusResponse> {
    return this.billing.getSpendStatus(this.ownTenantId(), period ?? periodOf(new Date()).label);
  }

  private ownTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required. Super-admins must use the /admin/billing endpoints.');
    }
    return tenantId;
  }
}
