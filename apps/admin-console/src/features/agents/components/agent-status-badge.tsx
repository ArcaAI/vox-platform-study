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

/** Platform (SYSTEM-owned, read-only template) vs the working tenant's own row. */
export function AgentOwnerBadge({ tenantId }: { tenantId: string }) {
  return tenantId === SYSTEM_TENANT_ID ? <Badge variant="secondary">Platform</Badge> : <Badge variant="outline">Tenant</Badge>;
}

export function isPlatformAgent(tenantId: string): boolean {
  return tenantId === SYSTEM_TENANT_ID;
}
