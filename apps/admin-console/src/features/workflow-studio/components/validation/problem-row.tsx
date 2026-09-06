'use client';

import { Badge } from '@arcaai/ui';
import type { WorkflowFinding } from '../../api/types';

export interface ProblemRowProps {
  finding: WorkflowFinding;
  onActivate: (finding: WorkflowFinding) => void;
}

export function ProblemRow({ finding, onActivate }: ProblemRowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onActivate(finding)}
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Badge variant={finding.severity === 'ERROR' ? 'destructive' : 'secondary'} className="mt-0.5 shrink-0 text-xs">
          {finding.severity}
        </Badge>
        <span className="min-w-0 flex-1">
          <span className="block">{finding.message}</span>
          <span className="text-muted-foreground flex flex-wrap items-baseline gap-x-1 font-mono text-xs">
            {finding.code ? <span>{finding.code}</span> : null}
            <span>{finding.ruleId}</span>
          </span>
        </span>
      </button>
    </li>
  );
}
