/**
 * TASK-798 W2 — the Substrate-A exclusivity detector.
 *
 * ## The hazard this exists to prevent
 *
 * A `WorkflowAssignment` row is not decoration: it is the switch that makes a tenant-authored
 * `consultation`-palette graph actually govern a consultation. `ConsultationWorkflowDispatchService`
 * resolves the assignment cascade at consultation open and, when a tier answers, starts a
 * Substrate-B interpreter run stamped `trigger: 'consultation open'`.
 *
 * Substrate A (`ConsultationLoopWorkflow` / `HarnessDocWorkflow`) is NOT stopped by that. It
 * starts lazily off the first context item, via `LoopContextSignalService`, whose
 * `loopAllowedFor()` currently consults exactly two things — the `harness.loop.emergencyStop`
 * platform veto and the tenant's `agenticLoop` entitlement. Neither knows nor asks whether a
 * tenant-authored graph is already governing this consultation.
 *
 * Substrate B's `consultation.persistDraft` node calls the SAME `persist_draft` activity
 * Substrate A uses. So with an assignment present and no gate, BOTH engines write one clinical
 * `ContextItem`: two writers, one document. That is a clinical-safety defect, not a race to be
 * tuned — which is why the assignment rows in `23-arcaai-workflow-authoring.ts` ship DISABLED and
 * this module, not a human's recollection, decides whether they may be enabled.
 *
 * ## What "the gate exists" is taken to mean
 *
 * TASK-795 owns `packages/applications/src/services/consultation/**` and is implementing the
 * exclusivity mechanism. The observable consequence must be that the loop-signal decision path
 * consults workflow governance — today it cannot, because the file's executable code contains no
 * reference to a workflow at all.
 *
 * So the probe is: **strip comments from `loop-context-signal.service.ts` and look for a
 * `workflow` reference in what remains.** Comment-stripping is load-bearing, not defensive
 * tidiness — that file's own docstring says "signals the `ConsultationLoopWorkflow`" and
 * "must not double-signal the workflow", so a raw text match would report the gate present today,
 * which is exactly backwards.
 *
 * ## Its failure modes, stated plainly
 *
 * The probe is a proxy, and a proxy can be wrong in two directions:
 *
 *  - **False negative** (795 implements the gate somewhere this probe does not look — e.g. a
 *    column on `Consultation`, or a check inside `HarnessGatewayService`). Consequence: the
 *    assignment stays disabled. Safe, and recoverable by widening the probe.
 *  - **False positive** (795 mentions a workflow in that file for some other reason). Consequence:
 *    the parity test in `task-798-arcaai-workflow-authoring.test.ts` goes RED, because the
 *    flag and the probe disagree. That RED is the design: it forces a HUMAN to read the gate and
 *    decide, and until someone does, the flag — and therefore the assignment — stays off.
 *
 * In neither direction does an assignment get written by accident. That is the only property this
 * module is required to have.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts` — the
 * single chokepoint through which all three Substrate-A signals (`contextAdded`,
 * `consultation-ending`, `loop-cancel`) pass, each behind `loopAllowedFor()`.
 */
export const LOOP_SIGNAL_SERVICE_PATH = path.resolve(
  HERE,
  '../../../../../applications/src/services/consultation/loop/loop-context-signal.service.ts',
);

export interface SubstrateExclusivityGateProbe {
  /** Overrides the file read — used by the detector's own tests. */
  readonly source?: string;
  readonly probedPath?: string;
}

export interface SubstrateExclusivityGateResult {
  /** True when the loop-signal decision path demonstrably consults workflow governance. */
  readonly present: boolean;
  /** The executable lines that carried the reference, for a human to read before trusting it. */
  readonly evidence: string[];
  readonly probedPath: string;
}

/** Remove block and line comments so prose about `ConsultationLoopWorkflow` cannot be evidence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

export function detectSubstrateExclusivityGate(probe: SubstrateExclusivityGateProbe = {}): SubstrateExclusivityGateResult {
  const probedPath = probe.probedPath ?? LOOP_SIGNAL_SERVICE_PATH;

  let source = probe.source;
  if (source === undefined) {
    // A missing file is NOT "no gate needed" — it means the probe has lost its target (the
    // service was renamed or moved). Report absent so the assignment stays off, and say why.
    if (!existsSync(probedPath)) {
      return { present: false, evidence: [`probe target not found: ${probedPath}`], probedPath };
    }
    source = readFileSync(probedPath, 'utf8');
  }

  const evidence = stripComments(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /workflow/i.test(line));

  return { present: evidence.length > 0, evidence, probedPath };
}
