'use client';

import { IconStarFilled } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { AGENT_TASK_LABEL, type AgentStatus, type AgentTask } from '../api';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const STATUS_VARIANT: Record<AgentStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  DRAFT: 'outline',
  VALIDATED: 'secondary',
  PUBLISHED: 'default',
  DEPRECATED: 'destructive',
};

export function AgentStatusBadge({ status, isActive }: { status: AgentStatus; isActive?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={STATUS_VARIANT[status]}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>
      {isActive ? (
        <Badge variant="secondary" className="gap-1">
          <IconStarFilled aria-hidden className="text-warning size-3" />
          Active
        </Badge>
      ) : null}
    </span>
  );
}

export function AgentTaskBadge({ task }: { task: AgentTask }) {
  return <Badge variant="outline">{AGENT_TASK_LABEL[task]}</Badge>;
}

/**
 * TASK-890 OD-M — provenance, not permission. `GET admin/agents` answers only rows this tenant
 * owns (the SYSTEM reference set is CLONED at provisioning, never read live), so every row here
 * IS the tenant's own and is mutable like any other draft. "Platform" names where the row's
 * CONTENT originally came from (`sourceTenantId`), not who may edit it — keying on `tenantId`
 * (the pre-TASK-890 shape) would key on a value that is now always the caller's own tenant.
 */
export function AgentOwnerBadge({ sourceTenantId }: { sourceTenantId: string | null }) {
  return sourceTenantId === SYSTEM_TENANT_ID ? <Badge variant="secondary">Platform origin</Badge> : <Badge variant="outline">Tenant</Badge>;
}

/** Whether this row was cloned from the platform's reference set — attribution only. */
export function isClonedFromPlatform(sourceTenantId: string | null): boolean {
  return sourceTenantId === SYSTEM_TENANT_ID;
}
