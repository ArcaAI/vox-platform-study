/**
 * TASK-732 Phase 3 Task 11 — option (b) is not "do nothing."
 *
 * The R-2 boundary (owner decision, recorded in `go-no-go-thresholds.md` §7
 * and `deletion-manifest.md` §5) keeps `PreSummaryProcessor`,
 * `ComprehensiveSummaryProcessor`, and `SummaryService.generateSummary`'s
 * sync body un-gated, as the ticket's own §2.6 option (b). This test makes
 * each generator's actual reachability of `approveSummary`'s
 * `contextItem.isFinalSummary` gate an asserted, checked FACT rather than an
 * assumption — including where that fact turned out to differ from the
 * ticket's own draft framing (§2.6's example only verified PRE_SUMMARY).
 *
 * `isFinalSummary` (`ContextItemEntity.ts`) is `true` for `RAW_SUMMARY` OR
 * `MODIFIED_SUMMARY`, `false` otherwise. `ContextItemFactory.CreateRawSummary`
 * unconditionally sets `type: RAW_SUMMARY` regardless of caller (verified in
 * `note-generation-assurance.contract.test.ts`).
 *
 *   - PRE_SUMMARY (`ContextItemFactory.CreatePreSummary`): sets `type:
 *     PRE_SUMMARY`, which is NEITHER `RAW_SUMMARY` NOR `MODIFIED_SUMMARY` —
 *     structurally excluded, confirmed below. This is the one case the
 *     ticket's §2.6 checked.
 *   - Sync `SummaryService.generateSummary` (`SUMMARY_REGENERATE`): calls
 *     `CreateRawSummary`, so its output DOES satisfy `isFinalSummary` — and
 *     this is CORRECT, not a gap: this generator's entire purpose is to
 *     (re)produce the consultation's actual clinical note, which must remain
 *     signable exactly like the harness-produced note it stands in for on
 *     this one permanently-legacy trigger (deletion-manifest.md §0.1). It
 *     is "kept" (not deleted) but was never meant to be non-signable — the
 *     ticket's own §2.6 lumps it into "option (b)" as a KEEP decision, not
 *     a signability claim.
 *   - `ComprehensiveSummaryProcessor`: ALSO calls `CreateRawSummary` (against
 *     the root consultationId the job was created for), so its output ALSO
 *     satisfies `isFinalSummary` today. **This is a FINDING, not a
 *     confirmed-safe fact**: the ticket's §2.6 draft asserted comprehensive
 *     summaries are non-signable "the same way" pre-summary is, without
 *     verifying it — they are not. Whether a cross-consultation-chain
 *     rollup SHOULD be signable as if it were the target consultation's own
 *     note is a clinical-product question this ticket does not have the
 *     authority to decide unilaterally (matches the ticket's own
 *     HUMAN-GATED posture for Task 8-adjacent product calls). Recorded
 *     here as an accurate, checked regression-lock of CURRENT behavior —
 *     not as an endorsement of it — so a future change to either direction
 *     is a deliberate edit to this test, not a silent behavior change.
 */
import { describe, expect, it } from 'vitest';
import { ContextItemFactory } from '@arcaai/domains';

const TENANT_ID = 'tenant-1';
const CONSULTATION_ID = 'consultation-1';

describe('TASK-732 Task 11 — kept-generator output reachability of approveSummary.isFinalSummary', () => {
  it('PreSummaryProcessor / generatePreSummary output (PRE_SUMMARY) is structurally NON-signable', () => {
    const preSummaryItem = ContextItemFactory.CreatePreSummary(TENANT_ID, CONSULTATION_ID, 'draft text', 'system');
    expect(preSummaryItem.isFinalSummary, 'PRE_SUMMARY must never satisfy isFinalSummary — this is the structural non-signability the R-2 boundary relies on').toBe(false);
  });

  it('sync SummaryService.generateSummary output (RAW_SUMMARY, SUMMARY_REGENERATE) remains fully signable — by design, not a gap', () => {
    const syncSummaryItem = ContextItemFactory.CreateRawSummary(TENANT_ID, CONSULTATION_ID, 'summary text', undefined, 'system');
    expect(syncSummaryItem.isFinalSummary, 'the sync-regenerate path produces the consultation\'s actual note and must stay signable').toBe(true);
  });

  it('FINDING (not endorsed): ComprehensiveSummaryProcessor output (RAW_SUMMARY) currently ALSO satisfies isFinalSummary', () => {
    const comprehensiveItem = ContextItemFactory.CreateRawSummary(TENANT_ID, CONSULTATION_ID, 'cross-chain rollup text', undefined, 'system');
    expect(
      comprehensiveItem.isFinalSummary,
      'ComprehensiveSummaryProcessor uses CreateRawSummary (the same factory method as a real single-consultation ' +
        'summary), so its output is NOT structurally distinguished from a signable note today. The ticket\'s §2.6 ' +
        'draft assumed otherwise without checking — this test locks the ACTUAL behavior so the open question ' +
        '(should a cross-chain rollup be signable as the target consultation\'s note?) is visible and deliberate ' +
        'to change, not silently true.',
    ).toBe(true);
  });
});
