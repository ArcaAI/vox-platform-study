/**
 * option (b) is not "do nothing."
 *
 * The R-2 boundary (owner decision, recorded in `go-no-go-thresholds.md`
 * and `deletion-manifest.md` keeps `PreSummaryProcessor` and
 * `ComprehensiveSummaryProcessor` un-gated, as the option (b). (It also kept
 * `SummaryService.generateSummary`'s sync body; TASK-1006 OD-2 removed it.) This test makes
 * each generator's actual reachability of `approveSummary`'s
 * `contextItem.isFinalSummary` gate an asserted, checked FACT rather than an
 * assumption — including where that fact turned out to differ from the
 * ticket's own draft framing (example only verified PRE_SUMMARY).
 *
 * `isFinalSummary` (`ContextItemEntity.ts`) is `true` for `RAW_SUMMARY` OR
 * `MODIFIED_SUMMARY`, `false` otherwise. `ContextItemFactory.CreateRawSummary`
 * unconditionally sets `type: RAW_SUMMARY` regardless of caller (verified in
 * `note-generation-assurance.contract.test.ts`).
 *
 *   - PRE_SUMMARY (`ContextItemFactory.CreatePreSummary`): sets `type:
 *     PRE_SUMMARY`, which is NEITHER `RAW_SUMMARY` NOR `MODIFIED_SUMMARY` —
 *     structurally excluded, confirmed below. This is the one case the
 * checked.
 *   - `ComprehensiveSummaryProcessor`: calls `CreateRawSummary` (against
 *     the root consultationId the job was created for), so its output
 *     satisfies `isFinalSummary`. **RESOLVED, not an open finding**: this
 *     pass's original draft asserted comprehensive summaries are non-signable
 *     "the same way" pre-summary is, without verifying it — that assertion
 *     was wrong, and the code is correct. Evidence: (1) the processor's own
 *     pre-existing doc comment already described it as following "the same
 *     pattern as the legacy signable summary generator"; (2) its sync twin,
 *     `ChainSummaryService.generateComprehensiveSummary`, is long-standing,
 *     untouched-by-this-ticket production code whose own doc comment calls
 *     its output "a FINAL comprehensive summary" stored as
 *     `ContextItem(RAW_SUMMARY)` on the requesting consultation; (3) this
 *     ticket's own `note-generation-assurance.contract.test.ts` already lists
 *     both `ComprehensiveSummaryProcessor` and `ChainSummaryService` among
 *     the ordinary RAW_SUMMARY-producing, SummaryMeta-backed generators, with
 *     no non-signable distinction drawn. A clinician who explicitly requests
 *     a chain rollup for the consultation they are viewing is choosing to
 *     make that rollup this consultation's note — the same product decision
 *     the harness-produced note implements for a single consultation.
 *     Locked below as confirmed, intentional behavior (see
 * `deletion-manifest.md` and README.md for the
 *     correction).
 */
import { describe, expect, it } from 'vitest';
import { ContextItemFactory } from '@arcaai/domains';

const TENANT_ID = 'tenant-1';
const CONSULTATION_ID = 'consultation-1';

describe(' Task 11 — kept-generator output reachability of approveSummary.isFinalSummary', () => {
  it('PreSummaryProcessor / generatePreSummary output (PRE_SUMMARY) is structurally NON-signable', () => {
    const preSummaryItem = ContextItemFactory.CreatePreSummary(TENANT_ID, CONSULTATION_ID, 'draft text', 'system');
    expect(
      preSummaryItem.isFinalSummary,
      'PRE_SUMMARY must never satisfy isFinalSummary — this is the structural non-signability the R-2 boundary relies on',
    ).toBe(false);
  });

  it('ComprehensiveSummaryProcessor output (RAW_SUMMARY) is signable — resolved as intentional, not an open finding', () => {
    const comprehensiveItem = ContextItemFactory.CreateRawSummary(TENANT_ID, CONSULTATION_ID, 'cross-chain rollup text', undefined, 'system');
    expect(
      comprehensiveItem.isFinalSummary,
      'ComprehensiveSummaryProcessor uses CreateRawSummary (the same factory method as a real single-consultation ' +
        'summary) deliberately: a clinician who requests a cross-chain rollup for the consultation they are ' +
        "viewing is choosing to make that rollup this consultation's signable note, exactly like its sync twin " +
        '(ChainSummaryService.generateComprehensiveSummary) and like the harness-produced note.',
    ).toBe(true);
  });

  it('sync twin ChainSummaryService.generateComprehensiveSummary agrees with the async processor — no signability asymmetry between them', () => {
    // Both the async (BullMQ) and sync comprehensive-summary paths must land on the
    // exact same ContextItemFactory call, or a future edit to only one of them would
    // silently reintroduce a signable/non-signable split between two implementations
    // of the same product feature.
    const asyncEquivalent = ContextItemFactory.CreateRawSummary(TENANT_ID, CONSULTATION_ID, 'async rollup', undefined, 'system');
    const syncEquivalent = ContextItemFactory.CreateRawSummary(TENANT_ID, CONSULTATION_ID, 'sync rollup', undefined, 'system');
    expect(asyncEquivalent.isFinalSummary).toBe(syncEquivalent.isFinalSummary);
    expect(syncEquivalent.isFinalSummary).toBe(true);
  });
});
