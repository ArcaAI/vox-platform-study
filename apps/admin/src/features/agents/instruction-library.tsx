import { Button } from '@arcaai/ui/button';
import { ItemList } from '@arcaai/ui/components/collection';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { PromptTemplate } from '@arcaai/vox';
import { RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import { categoryLabel, promptStatusLabel, promptStatusRole } from './instruction-draft';
import { formatScore } from './playground-format';

/**
 * Department instruction library (frame 30, lower half). Lists the
 * department-scoped `PromptTemplate`s (`usePrompts.list({ departmentId })`) with
 * name · category · v# · status · last test score, and opens the instruction
 * workspace on row click. Renders its own error+retry block (ItemList has no
 * retry affordance) and a department-specific empty state.
 */
export function InstructionLibrary({
  prompts,
  isLoading,
  error,
  onRetry,
  onOpen,
  emptyLabel,
}: {
  prompts: PromptTemplate[];
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  onOpen: (prompt: PromptTemplate) => void;
  emptyLabel: string;
}) {
  if (error && prompts.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-md border p-10 text-center">
        <TriangleAlert className="size-9 text-destructive" />
        <div>
          <p className="font-medium">Couldn’t load instructions</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="size-4" />
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <ItemList<PromptTemplate>
      aria-label="Agent instructions"
      items={prompts}
      getItemId={(p) => p.id}
      isLoading={isLoading}
      onRowClick={(id) => {
        const prompt = prompts.find((p) => p.id === id);
        if (prompt) onOpen(prompt);
      }}
      emptyState={
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Sparkles />
            </EmptyMedia>
            <EmptyTitle>{emptyLabel}</EmptyTitle>
            <EmptyDescription>Create a department instruction to steer the clinical pipeline.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
      renderRow={(p) => (
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <Sparkles aria-hidden className="size-4 shrink-0 text-ai" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{p.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {categoryLabel(p.category)} · v{p.currentVersionNumber}
            </span>
          </span>
          <StatusBadge label={promptStatusLabel(p.status)} colorRole={promptStatusRole(p.status)} />
          <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground" title="Last test score">
            {formatScore(p.lastTestScore)}
          </span>
        </span>
      )}
    />
  );
}
