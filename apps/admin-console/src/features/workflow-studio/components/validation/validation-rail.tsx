'use client';

/**
 * `ValidationRail` — the server `ValidationReport` grouped by severity then
 * node. Activating a row moves both selection AND DOM focus (`use-focus-node.ts`). Findings with
 * `nodeId === null` are graph-level (README: "a graph-level bucket… distinct from per-node
 * groups" — `WF-INTERNAL`/`WF-SHAPE` land there per `validation-report.contract.md`).
 */
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@arcaai/ui';
import { IconCircleCheck } from '@tabler/icons-react';
import { humanizeKey } from '../../lib/schema-form';
import type { WorkflowFinding, WorkflowValidationReport } from '../../api/types';
import type { GraphStoreNode } from '../../store/types';
import { ProblemRow } from './problem-row';

export interface ValidationRailProps {
  report: WorkflowValidationReport | null;
  nodes: GraphStoreNode[];
  onActivate: (finding: WorkflowFinding) => void;
}

/** The sole publish-blocking predicate, read off the server report — never re-derived from
 *  `findings` client-side (`validation-report.contract.md`: "the Studio never re-derives `ok`
 *  from `findings` itself"). `null` = no report yet (Validate has not run). */
export function publishBlockedReason(report: WorkflowValidationReport | null): string | null {
  if (!report) return 'Run Validate before publishing.';
  if (!report.ok) return 'Resolve every error before publishing.';
  return null;
}

function labelForNode(nodes: GraphStoreNode[], nodeId: string): string {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node ? humanizeKey(node.type) : nodeId;
}

export function ValidationRail({ report, nodes, onActivate }: ValidationRailProps) {
  const findings = report?.findings ?? [];
  const errors = findings.filter((finding) => finding.severity === 'ERROR');
  const warnings = findings.filter((finding) => finding.severity === 'WARNING');
  const graphLevel = findings.filter((finding) => finding.nodeId === null);
  const perNode = new Map<string, WorkflowFinding[]>();
  for (const finding of findings) {
    if (finding.nodeId === null) continue;
    const bucket = perNode.get(finding.nodeId) ?? [];
    bucket.push(finding);
    perNode.set(finding.nodeId, bucket);
  }

  const summary = !report
    ? 'Not yet validated.'
    : findings.length === 0
      ? 'No problems found.'
      : `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`;

  if (findings.length === 0) {
    return (
      <div>
        <div aria-live="polite" className="sr-only">
          {summary}
        </div>
        <Empty>
          <EmptyMedia variant="icon">
            <IconCircleCheck aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{report ? 'No problems found' : 'Not yet validated'}</EmptyTitle>
          <EmptyDescription>{report ? 'This definition is clean.' : 'Run Validate to see the server report.'}</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite" className="sr-only">
        {summary}
      </div>
      <p className="text-muted-foreground text-sm">{summary}</p>
      {graphLevel.length > 0 ? (
        <div>
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Graph</h3>
          <ul className="flex flex-col gap-1">
            {graphLevel.map((finding) => (
              <ProblemRow key={`${finding.ruleId}-${finding.message}`} finding={finding} onActivate={onActivate} />
            ))}
          </ul>
        </div>
      ) : null}
      {[...perNode.entries()].map(([nodeId, nodeFindings]) => (
        <div key={nodeId}>
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{labelForNode(nodes, nodeId)}</h3>
          <ul className="flex flex-col gap-1">
            {nodeFindings.map((finding) => (
              <ProblemRow key={`${finding.ruleId}-${finding.message}`} finding={finding} onActivate={onActivate} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
