/**
 * TASK-939 §6.1 — the ACCUMULATION INVARIANT, as a checkable function.
 *
 * The owner's requirement is one sentence: a partial-summary turn must ADD to the case note, not
 * rebuild it. This module is the machine-checkable form of that sentence, so a replay against a real
 * recording produces a number rather than an impression.
 *
 * ## The invariant
 *
 * For each `(documentKey, sectionKey)`, across consecutive `revision`s:
 *
 *   `content[r]` MUST be a PREFIX of `content[r+1]`
 *
 * unless the turn that produced `r+1` named a transcript contradiction — which, on the wire, is a
 * patch carrying NO `appended` (a replace) for a section that already had content.
 *
 * Characters that break the prefix rule are CHURN: text the clinician had already read and then
 * watched change. Zero is the design target; the pre-ticket engine produced churn on nearly every
 * turn, because every turn re-emitted the whole document.
 *
 * ## Why a prefix test and not a diff
 *
 * A diff would report how much changed. What matters clinically is narrower and harsher: whether
 * anything the clinician had ALREADY READ moved. A note that grows is fine however fast it grows; a
 * note that rewrites its second paragraph while someone is reading the fourth is the defect. The
 * prefix test is also the same rule the service's own `noteChurnChars` metric and the accumulation
 * unit test apply, so one number means the same thing in all three places.
 *
 * Deliberately transport-agnostic and PHI-free in what it RETURNS: it takes patches and reports
 * sizes, counts and addresses. Callers must not log the content it inspects.
 */

/** The fields of a `section.patch` this checker needs. Structurally compatible with `SectionPatchDto`. */
export interface ChurnPatch {
  readonly documentKey: string;
  readonly sectionKey: string;
  readonly revision: number;
  readonly content: string;
  /** Present when the flush APPENDED; absent on a replace. */
  readonly appended?: string;
  /** A degrade patch (`revision: 0`, empty content) is not a content write and is skipped. */
  readonly degradeReason?: string;
}

/** One violation of the invariant. Addresses and sizes only — never the text. */
export interface ChurnViolation {
  readonly documentKey: string;
  readonly sectionKey: string;
  /** The revision that broke the prefix rule. */
  readonly revision: number;
  /** The revision it was compared against. */
  readonly previousRevision: number;
  /** Characters of previously-published text that this revision rewrote. */
  readonly churnedChars: number;
  /** True when the patch at least declared itself a replace (no `appended`) rather than an append. */
  readonly declaredReplace: boolean;
}

export interface ChurnReport {
  /** Total characters of already-read text that were rewritten across the whole session. */
  readonly churnedChars: number;
  /** Content-bearing patches examined (degrade patches excluded). */
  readonly patchCount: number;
  /** Distinct `(documentKey, sectionKey)` addresses seen. */
  readonly sectionCount: number;
  /** Patches that grew their section without disturbing a character of it. */
  readonly cleanAppends: number;
  /** Patches that replaced existing content. Legitimate only as a named contradiction. */
  readonly replacements: number;
  readonly violations: ChurnViolation[];
  /** Final body length per `documentKey::sectionKey` — a size, never the text. */
  readonly finalChars: Record<string, number>;
}

const addressOf = (patch: ChurnPatch): string => `${patch.documentKey}::${patch.sectionKey}`;

/**
 * Fold a session's `section.patch` stream into a churn report.
 *
 * Patches may arrive out of order (the SSE plane makes no ordering guarantee), so they are sorted per
 * section by `revision` before comparison — the same discard rule every client applies. A repeated
 * revision is ignored rather than compared: it is a duplicate delivery, not a rewrite.
 */
export function analyseNoteChurn(patches: readonly ChurnPatch[]): ChurnReport {
  const bySection = new Map<string, ChurnPatch[]>();
  for (const patch of patches) {
    // A degrade patch carries `revision: 0` and an empty body: it reports a FAILED generation and
    // persists nothing, so counting it as a content write would invent churn out of an outage.
    if (patch.degradeReason) continue;
    const list = bySection.get(addressOf(patch)) ?? [];
    list.push(patch);
    bySection.set(addressOf(patch), list);
  }

  const violations: ChurnViolation[] = [];
  const finalChars: Record<string, number> = {};
  let churnedChars = 0;
  let patchCount = 0;
  let cleanAppends = 0;
  let replacements = 0;

  for (const [address, list] of bySection) {
    const ordered = [...list].sort((a, b) => a.revision - b.revision);
    let previous: ChurnPatch | undefined;

    for (const patch of ordered) {
      if (previous && patch.revision === previous.revision) continue; // duplicate delivery
      patchCount += 1;

      if (previous) {
        const prior = previous.content;
        if (prior.length > 0 && !patch.content.startsWith(prior)) {
          churnedChars += prior.length;
          replacements += 1;
          violations.push({
            documentKey: patch.documentKey,
            sectionKey: patch.sectionKey,
            revision: patch.revision,
            previousRevision: previous.revision,
            churnedChars: prior.length,
            // A replace ANNOUNCES itself by carrying no `appended`. An "append" that broke the
            // prefix rule is worse than a replace: it claimed not to disturb anything and did.
            declaredReplace: patch.appended === undefined,
          });
        } else if (patch.content.length > prior.length) {
          cleanAppends += 1;
        }
      } else if (patch.content.length > 0) {
        cleanAppends += 1;
      }

      previous = patch;
    }

    finalChars[address] = previous?.content.length ?? 0;
  }

  return {
    churnedChars,
    patchCount,
    sectionCount: bySection.size,
    cleanAppends,
    replacements,
    violations,
    finalChars,
  };
}

/**
 * A one-line, PHI-free summary for a test failure message or a run log.
 *
 * Built here rather than at each call site so a replay's output is comparable run to run — a BEFORE
 * and an AFTER number only mean something if they were rendered the same way.
 */
export function formatChurnReport(report: ChurnReport): string {
  return [
    `churnedChars=${report.churnedChars}`,
    `patches=${report.patchCount}`,
    `sections=${report.sectionCount}`,
    `cleanAppends=${report.cleanAppends}`,
    `replacements=${report.replacements}`,
    `violations=${report.violations.length}`,
  ].join(' ');
}
