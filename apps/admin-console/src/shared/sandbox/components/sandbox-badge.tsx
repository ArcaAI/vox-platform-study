import { IconFlask } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';

/** The run-header sandbox marker (moved from `features/workbench/components/sandbox-badge.tsx`,
 *  TASK-893). `variant="secondary"` + the word "Sandbox" — never color alone (rule 11 §7). */
export function SandboxBadge() {
  return (
    <Badge variant="secondary" className="gap-1">
      <IconFlask aria-hidden className="size-3" />
      Sandbox
    </Badge>
  );
}
