'use client';

/**
 * "Which engine is writing this note?" — the read-back of the workflow chosen at open
 * (TASK-858 Lane D, over TASK-813's `useConsultationWorkflow`).
 *
 * Selecting a workflow at open does not GUARANTEE it runs: consultation-open dispatch is
 * best-effort by design, so a harness outage degrades to the platform's default engine rather
 * than failing the open. That is the whole reason a read-back exists — and why the three states
 * stay distinct. `null` is honestly "we could not read it", NEVER "the default engine governs";
 * collapsing them would report a working tenant workflow as absent whenever a request blipped.
 *
 * Fail-open: an informational read must never block capture, so every state renders something
 * small and truthful and nothing here can throw.
 */

import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Structural subset of the SDK's `ConsultationWorkflow` this line renders. */
export interface GoverningWorkflow {
  governed: boolean;
  workflowDefinitionSlug: string | null;
  name: string | null;
  activeVersionNumber: number | null;
}

export interface GoverningWorkflowMetaProps {
  /** `null` = unknown (not yet read, or the read failed) — never "default engine". */
  workflow: GoverningWorkflow | null;
  isLoading?: boolean;
  /** No consultation ⇒ there is nothing to govern yet, so the line is absent rather than empty. */
  hasConsultation: boolean;
}

export function GoverningWorkflowMeta({ workflow, isLoading = false, hasConsultation }: GoverningWorkflowMetaProps) {
  if (!hasConsultation) return null;

  if (!workflow && isLoading) return <Skeleton className="h-5 w-44 rounded-full" />;

  if (!workflow) {
    return (
      <Badge variant="outline" title="The governing-engine read did not resolve; capture is unaffected.">
        Governing workflow unknown
      </Badge>
    );
  }

  if (!workflow.governed) return <Badge variant="outline">Default engine governs</Badge>;

  const label = workflow.name ?? workflow.workflowDefinitionSlug ?? 'workflow';
  const version = workflow.activeVersionNumber != null ? ` v${workflow.activeVersionNumber}` : '';
  return (
    <Badge variant="secondary">
      Governed by {label}
      {version}
    </Badge>
  );
}
