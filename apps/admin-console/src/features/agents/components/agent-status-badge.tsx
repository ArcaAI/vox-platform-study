'use client';

import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { AGENT_TASK_LABEL, type AgentTask } from '../api';

/**
 * TASK-965 WS-4 — `AgentStatusBadge`, `AgentOwnerBadge` and `isClonedFromPlatform` were REMOVED
 * here, not deprecated: the kit owns both axes now.
 *
 * `AgentStatusBadge` conflated two orthogonal things — the lifecycle status and whether the
 * version is the one being SERVED — in one span, and spent the `destructive` variant on
 * `DEPRECATED`, which is an end state an admin chose rather than a failure (INV-1). Status is
 * `LifecycleStatusBadge` and liveness is `ActiveBadge`, both from `@/shared/versioning`, so every
 * versioned screen says it the same way. `AgentOwnerBadge` is `OriginBadge` from the same kit.
 *
 * What stays here is what is genuinely agent-specific: the TASK a lineage is typed by, and the
 * platform-hidden flag.
 */
export function AgentTaskBadge({ task }: { task: AgentTask }) {
  return <Badge variant="outline">{AGENT_TASK_LABEL[task]}</Badge>;
}

/**
 * TASK-974 §4.7 (D-1) — a platform service agent (e.g. `dna-writing-style-analyst`): one SYSTEM
 * row every tenant's jobs resolve against, never cloned, never listed or invokable on the
 * business plane. Renders nothing for an ordinary tenant agent.
 */
export function AgentHiddenBadge({ hidden }: { hidden?: boolean }) {
  if (!hidden) return null;
  return (
    <Badge variant="outline" title="Platform service agent — never cloned to tenants, not listed or invokable on the business plane">
      Hidden · platform
    </Badge>
  );
}
