'use client';

import type { RunView } from '@/shared/sandbox/api/run-fold';
import { RunGuardrailSummary } from '@/shared/sandbox/components/run-guardrail-summary';
import { Panel } from './panel';

/** True once the run screened, raised a notice or paused on a guardrail hold. */
export function hasGuardrailActivity(view: RunView): boolean {
  if (view.paused || (view.guardrailNotices?.length ?? 0) > 0) return true;
  return view.nodeOrder.some((id) => (view.nodes[id]?.guardrails.length ?? 0) > 0);
}

/**
 * TASK-1050 W3b round 2 — the Test tab's Guardrail panel: the shared run-trace guardrail view
 * (`RunGuardrailSummary`) over the same time-travelled fold the rest of the tab reads, so it shows the
 * paused state, the notices and each step's screens (incl. WARN / IGNORE) at the event being viewed.
 * Absent until the run has guardrail activity, so a clean run keeps the tab as it was.
 */
export function TestGuardrailPanel({ view }: { view: RunView }) {
  if (!hasGuardrailActivity(view)) return null;
  return (
    <Panel title="Guardrail">
      <RunGuardrailSummary view={view} />
    </Panel>
  );
}
