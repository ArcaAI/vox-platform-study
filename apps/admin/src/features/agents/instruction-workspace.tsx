import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Link } from '@tanstack/react-router';
import type { PromptTemplate } from '@arcaai/vox';
import { ArrowLeft, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { initialsOf, cn } from '@/lib/utils';
import { categoryLabel, promptStatusLabel, promptStatusRole } from './instruction-draft';

const TAB_CLASS = cn(
  '-mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
  'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'data-[status=active]:border-primary data-[status=active]:text-foreground',
);

/**
 * Instruction-workspace chrome (frames 31–33): a back link to the department
 * agent library, the instruction identity header (name · category · locked scope ·
 * status · v#), a mode-specific actions slot, and the Editor / Version history /
 * Test playground sub-tab nav. The active mode is shown here, not in the breadcrumb.
 */
export function InstructionWorkspaceShell({
  prompt,
  tenantId,
  departmentId,
  promptId,
  active,
  actions,
  children,
}: {
  prompt: PromptTemplate;
  tenantId: string;
  departmentId: string;
  promptId: string;
  active: 'editor' | 'diff' | 'playground';
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link
        to="/tenants/$tenantId/departments/$departmentId/agents"
        params={{ tenantId, departmentId }}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-4" />
        Agent instructions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarFallback className="rounded-lg bg-ai/10 text-base font-semibold text-ai">{initialsOf(prompt.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{prompt.name}</h1>
              <StatusBadge label={promptStatusLabel(prompt.status)} colorRole={promptStatusRole(prompt.status)} />
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              <span>{categoryLabel(prompt.category)}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                DEPARTMENT_DEFAULT
                <Lock className="size-3" aria-label="Scope locked" />
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">v{prompt.currentVersionNumber}</span>
            </p>
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      <nav aria-label="Instruction modes" className="flex gap-1 overflow-x-auto border-b border-border">
        <Link
          to="/tenants/$tenantId/departments/$departmentId/agents/$promptId"
          params={{ tenantId, departmentId, promptId }}
          data-status={active === 'editor' ? 'active' : undefined}
          className={TAB_CLASS}
        >
          Editor
        </Link>
        <Link
          to="/tenants/$tenantId/departments/$departmentId/agents/$promptId/diff"
          params={{ tenantId, departmentId, promptId }}
          data-status={active === 'diff' ? 'active' : undefined}
          className={TAB_CLASS}
        >
          Version history
        </Link>
        <Link
          to="/tenants/$tenantId/departments/$departmentId/agents/$promptId/playground"
          params={{ tenantId, departmentId, promptId }}
          data-status={active === 'playground' ? 'active' : undefined}
          className={TAB_CLASS}
        >
          Test playground
        </Link>
      </nav>

      {children}
    </div>
  );
}
