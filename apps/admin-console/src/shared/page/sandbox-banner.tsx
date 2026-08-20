import { IconFlask } from '@tabler/icons-react';

/**
 * Sandbox containment banner (TASK-721 Task 9) — the CLIENT-SIDE disclosure half of the
 * sandbox-containment guardrail. The SERVER side is the actual boundary: every run started
 * from the Workbench is written with `isSandbox: true` (`WorkflowSandboxRunService.startRun`),
 * and real-data run surfaces (`admin/workflow-runs`) exclude sandbox rows BY DEFAULT at the
 * query level (`IWorkflowRunService.listRuns`'s `includeSandbox` filter, default `false`). This
 * banner is the disclosure, not the guardrail — sibling of `playground-banner.tsx`, same
 * `role="note"` pattern, in the `statusBanner` slot of `ScreenTemplate`.
 *
 * Rule 11 §7: color is never the only signal — the word "Sandbox" carries the meaning, the
 * amber tint reinforces it.
 */
export function SandboxBanner() {
  return (
    <div
      role="note"
      className="border-warning/30 bg-warning/10 text-warning-strong flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
    >
      <IconFlask aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Sandbox — this run never writes external artifacts and cannot reach a signed state. Not clinical output.
      </span>
    </div>
  );
}
