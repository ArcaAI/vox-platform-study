import { ForbiddenException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { isSuperAdmin } from '../../common/tenant-guards';

/**
 * Who may read a composed prompt — the Prompt Inspector preview and the composed-prompt records.
 * Both return a consultation's prompt with its PHI, so the audience is narrower than
 * `read:Consultation`, which a doctor also holds (owner decision OD-9).
 */
const PROMPT_INSPECTOR_TENANT_ROLES = ['TENANT_ADMIN'];

export interface PromptInspectorCaller {
  user: { id?: string | null; roles?: string[] | null } | null | undefined;
  /** The authenticated service account, when the caller is one (CLS `serviceAccount`). */
  serviceAccount?: unknown;
  tenantId: string;
  roleAssignments?: { findAll(args: { where: Record<string, unknown> }): Promise<Array<{ Roles?: Array<{ name: string }> | null }>> };
  logger?: { warn(message: string): void };
}

/** The refusal a caller may brand as its own surface's; the default is the Prompt Inspector's. */
export interface PromptInspectorRefusal {
  code?: string;
  message?: string;
}

/**
 * SUPER_ADMIN, or TENANT_ADMIN of THIS tenant; otherwise 403.
 *
 * A service account passes: it is the admin plane's machine identity, bound to its working tenant
 * at exchange and already scope-checked (`svc:admin:consultation-admin:manage`).
 *
 * The tenant-admin read is TENANT-SCOPED, the same read as the DNA ingest gate: a user who
 * administers tenant B is nobody in tenant A, and the JWT's role list answers across tenants.
 *
 * The answer never depends on a row, so callers run it BEFORE resolving any id — every caller
 * without the privilege gets the same 403 whether the id exists or not. Fails closed: no user, no
 * repository or an unreadable role list is a 403.
 */
export async function assertPromptInspectorAccess(caller: PromptInspectorCaller, refusal: PromptInspectorRefusal = {}): Promise<void> {
  if (caller.serviceAccount) return;
  if (isSuperAdmin(caller.user)) return;

  const userId = caller.user?.id;
  if (userId && caller.roleAssignments) {
    try {
      const assignments = await caller.roleAssignments.findAll({
        where: { userId, tenantId: caller.tenantId, resourceStatus: ResourceStatusType.ENABLED },
      });
      if (assignments.some((assignment) => (assignment.Roles ?? []).some((role) => PROMPT_INSPECTOR_TENANT_ROLES.includes(role.name)))) return;
    } catch (error) {
      caller.logger?.warn(`Could not read the roles of ${userId}; refusing the prompt read: ${error}`);
    }
  }

  throw new ForbiddenException({
    code: refusal.code ?? 'PROMPT_INSPECTOR_FORBIDDEN',
    message:
      refusal.message ?? 'Composed prompts carry patient data and are readable only by a super administrator or a tenant administrator of this tenant.',
  });
}
