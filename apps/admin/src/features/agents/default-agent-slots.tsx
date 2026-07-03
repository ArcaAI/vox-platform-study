import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { PromptTemplate } from '@arcaai/vox';
import { FlaskConical } from 'lucide-react';
import { categoryLabel, promptStatusLabel, promptStatusRole } from './instruction-draft';
import type { AgentSlot, SlotAssignment } from './slot-config';

interface SlotActions {
  canManage?: boolean;
  onChange: (slot: AgentSlot) => void;
  onEdit: (prompt: PromptTemplate) => void;
  onHistory: (prompt: PromptTemplate) => void;
  onTest: (prompt: PromptTemplate) => void;
}

function SlotCard({ assignment, canManage, onChange, onEdit, onHistory, onTest }: { assignment: SlotAssignment } & SlotActions) {
  const { slot, prompt } = assignment;
  const target = Boolean(slot.target);

  return (
    <div className="flex h-full flex-col gap-2.5 rounded-lg border bg-card p-4" data-slot="agent-slot-card">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{slot.eyebrow}</span>
        {target ? <StatusBadge label="Target" colorRole="hope" icon={<FlaskConical />} /> : null}
      </div>

      {prompt ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate font-semibold leading-tight" title={prompt.name}>
            {prompt.name}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {categoryLabel(prompt.category)} · v{prompt.currentVersionNumber}
          </p>
          <StatusBadge className="w-fit" label={promptStatusLabel(prompt.status)} colorRole={promptStatusRole(prompt.status)} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="font-medium text-muted-foreground">{target ? 'Not wired' : 'Not assigned'}</p>
          <p className="text-xs text-muted-foreground">{slot.description}</p>
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {prompt ? (
          <>
            <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => onEdit(prompt)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => onHistory(prompt)}>
              History
            </Button>
            <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => onTest(prompt)}>
              Test
            </Button>
          </>
        ) : null}
        {canManage && !target ? (
          <Button variant="outline" size="sm" className="h-9 px-2.5" onClick={() => onChange(slot)}>
            {prompt ? 'Change' : 'Assign'}
          </Button>
        ) : null}
        {target ? <span className="text-[11px] text-muted-foreground">No backing column yet</span> : null}
      </div>
    </div>
  );
}

/**
 * Default-agent slot cards (frame 30, top): the three summary slots wired via
 * `Department.preSummaryPromptId / newPatientPromptId / revisitPromptId`, plus the
 * **DNA writing-style** slot wired via `Department.dnaWritingStylePromptId`
 * (TASK-387 #7). Resolution is done by `resolveSlotAssignments`; this is presentation only.
 */
export function DefaultAgentSlots({ assignments, isLoading, ...actions }: { assignments: SlotAssignment[]; isLoading?: boolean } & SlotActions) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {assignments.map((assignment) => (
        <SlotCard key={assignment.slot.key} assignment={assignment} {...actions} />
      ))}
    </div>
  );
}
