import { ForbiddenException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { isSuperAdmin } from '../../common/tenant-guards';

/**
 * TASK-1050 W2h — the ONE gate of every `admin/guardrail/{policy-keys,judge-models,judge-lanes,dry-run,metrics}`
 * route: a SUPER_ADMIN in a tenant-less context (or the SYSTEM tenant). A customer working tenant is refused,
 * because the writes target SYSTEM rows and the monitoring reads span every tenant — the posture of model
 * residency and promote-to-system.
 *
 * ROW-INDEPENDENT (the same answer for every key, model and id), so it runs FIRST (rule 05): there is no id
 * space to protect. A 403 privilege boundary, never the 404-over-403 cross-tenant posture.
 */
export function assertGuardrailPlatformAdmin(user: unknown, tenantId: string | null, action: string): void {
  if (!isSuperAdmin(user as Parameters<typeof isSuperAdmin>[0])) throw new ForbiddenException(`Only platform administrators may ${action}.`);
  if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
    throw new ForbiddenException(`Guardrail control is platform-wide; clear the working tenant to ${action}.`);
  }
}
