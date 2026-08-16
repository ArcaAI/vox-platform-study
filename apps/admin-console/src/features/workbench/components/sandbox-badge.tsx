import { IconFlask } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';

/** The run-header + artifact-pane sandbox marker (Task 9's second disclosure point, alongside
 *  `SandboxBanner`). `variant="secondary"` + the word "Sandbox" — never color alone (rule 11 §7). */
export function SandboxBadge() {
  return (
    <Badge variant="secondary" className="gap-1">
      <IconFlask aria-hidden className="size-3" />
      Sandbox
    </Badge>
  );
}
