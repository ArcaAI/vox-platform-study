import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isSuperAdmin } from '../../common';

/**
 * TASK-1050 — the tenant an `admin/guardrail/*` tenant-plane route acts on: the CLS working tenant.
 *
 * AUTH-NOTE (existence first): a non-super-admin whose own tenant is not the working tenant gets 404,
 * so another tenant's rules are never acknowledged (404-over-403). No working tenant is 400 — a request
 * with no tenant context never silently reads SYSTEM.
 */
export function resolveGuardrailWorkingTenant(tenantId: string | null | undefined, user: { tenantId?: string | null; roles?: string[] | null } | null | undefined): string {
  if (!tenantId) {
    throw new BadRequestException({ message: 'Select a working tenant to read, change or test its guardrail rules.', code: 'WORKING_TENANT_REQUIRED' });
  }
  if (!isSuperAdmin(user) && user?.tenantId && user.tenantId !== tenantId) {
    throw new NotFoundException('Guardrail policy not found');
  }
  return tenantId;
}
