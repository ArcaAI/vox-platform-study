import { IconBulb } from '@tabler/icons-react';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';
import { formatRelativeTime } from '@/shared/format';
import type { ResidencySuggestion } from '../api/types';

/**
 * Shadow-mode suggestions (ticket §13.2): what the policy engine would have
 * done, already rewritten server-side as one plain sentence each. Read-only —
 * shadow mode is a REVIEW step (7 days of data before `residency.enforce`),
 * not a queue of actions to approve here; an admin who agrees uses the
 * Load/Unload row action directly.
 */
export function SuggestionsPanel({ suggestions }: { suggestions: ResidencySuggestion[] }) {
  return (
    <Card className="gap-3 p-4">
      <h2 className="text-sm font-medium">Suggestions</h2>
      {suggestions.length === 0 ? (
        <EmptyState
          icon={IconBulb}
          title="No suggestions yet"
          description="The policy engine logs what it would load or unload here before anything is enforced."
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Suggestions">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id} className="border-b pb-2 text-sm last:border-b-0 last:pb-0">
              <p>{suggestion.text}</p>
              <p className="text-muted-foreground text-xs">{formatRelativeTime(suggestion.at)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
