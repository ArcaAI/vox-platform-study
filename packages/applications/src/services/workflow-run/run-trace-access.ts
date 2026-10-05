import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { ResourceStatusType, UserRoleAssignmentRepository } from '@arcaai/domains';
import { isSuperAdmin } from '../../common/tenant-guards';

/** The tenant-scoped role that may read a run's admin trace (besides a super admin). */
const RUN_TRACE_TENANT_ROLES = ['TENANT_ADMIN'];
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export interface RunTraceCaller {
  user: { id?: string | null; roles?: string[] | null } | null | undefined;
  /** The authenticated service account, when the caller is one (CLS `serviceAccount`). */
  serviceAccount?: unknown;
  /** The WORKING tenant the run must belong to. */
  tenantId: string;
}

/**
 * TASK-1038 B3a — who may open the ADMIN TRACE of a run (`GET admin/workflow-runs/:runId/trace/stream`).
 *
 * The trace carries EVERY stored run event (protocol-v2.md §5) — debug events, every node's
 * outputs, `error.detail`, PHI — so its audience is narrower than `read:WorkflowRun`, which a
 * clinician may also hold. It is the console's Test tab and nothing else: a SUPER_ADMIN, or a
 * TENANT_ADMIN of the working tenant. Machine credentials never reach it (the route also carries
 * `@ForbidApiKey()` + `@ForbidServiceAccount()`; this refuses a service account again so the rule
 * cannot be lost by a decorator edit).
 *
 * The role read is TENANT-SCOPED (a user who administers tenant B is nobody in tenant A), with
 * one widening: a SUPER_ADMIN assignment in any tenant — a ticket-restored EventSource session
 * carries no roles, so the session list cannot be the only witness. Row-INDEPENDENT, so callers
 * run it BEFORE resolving the run: every caller without the privilege gets the same 403 whether
 * the id exists or not. Fails closed on no user, no repository or an unreadable role list.
 */
@Injectable()
export class WorkflowRunTraceAccessService {
  private readonly logger = new Logger(WorkflowRunTraceAccessService.name);

  constructor(@Optional() private readonly roleAssignments?: UserRoleAssignmentRepository) {}

  async assertCanTrace(caller: RunTraceCaller): Promise<void> {
    if (!caller.serviceAccount && isSuperAdmin(caller.user)) return;
    const userId = caller.user?.id;
    if (!caller.serviceAccount && userId && this.roleAssignments) {
      try {
        const assignments = (await this.roleAssignments.findAll({
          where: { userId, resourceStatus: ResourceStatusType.ENABLED },
        })) as Array<{ tenantId?: string; Roles?: Array<{ name: string }> | null }>;
        const allowed = assignments.some((assignment) =>
          (assignment.Roles ?? []).some(
            (role) => role.name === SUPER_ADMIN_ROLE || (assignment.tenantId === caller.tenantId && RUN_TRACE_TENANT_ROLES.includes(role.name)),
          ),
        );
        if (allowed) return;
      } catch (error) {
        this.logger.warn(`Could not read the roles of ${userId}; refusing the run trace: ${error}`);
      }
    }
    throw new ForbiddenException({
      code: 'RUN_TRACE_FORBIDDEN',
      message: 'The run trace carries every event of the run, patient data included, and is readable only by a super administrator or a tenant administrator of this tenant.',
    });
  }
}
