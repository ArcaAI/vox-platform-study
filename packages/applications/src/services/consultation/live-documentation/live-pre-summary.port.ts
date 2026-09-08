/**
 * TASK-932 D-9 — the NARROW port through which the live session runs a WARM-START node.
 *
 * ## What the graph decides, and what this runs
 *
 * `n_presummary` on the consultation graph is what makes the pre-summary a step of the workflow:
 * it declares THAT the warm start happens, WHICH agent it is (`agentRef.slug`), that it runs on
 * the realtime lane at the `onStart` cadence, and that it DEGRADES rather than fails. The durable
 * interpreter skips it like every other realtime node with a live owner, so exactly one runtime
 * owns it — this one.
 *
 * How it GENERATES is this port's implementation, and that is deliberately not a second copy of
 * the pre-summary pipeline. `SummaryService.generatePreSummary` already assembles the pre-summary
 * prompt through the tenant tier (the same v3 body the agent binds), calls TEXT with a FREE-FORM
 * response — a pre-summary is Markdown under five headings, not the note's strict `json_schema` —
 * encrypts the result, persists the `PRE_SUMMARY` context item that `resolveWarmStartPreSummary`
 * and the case-note column read, records `SummaryMeta`, and meters the call. Re-implementing that
 * inside the live service would be a second pipeline to keep in step with the first, which is the
 * failure mode `27-document-template-library.ts` and `07e` both carry explicit notes about.
 *
 * ## The seam that is NOT closed, stated plainly
 *
 * The node's `agentRef.slug` is carried on {@link LivePreSummaryInput.agentSlug} and REPORTED,
 * but the implementation does not select the model from it: `generatePreSummary` resolves the
 * prompt through `PromptAssemblyService`'s pre-summary chain and the model through the tenant's
 * text selection. For every seeded tenant those resolve to the same body the agent binds (the
 * tenant-tier v3 pre-summary) and the same model (`lms-gemma-4-e2b-it-qat`), so today the two
 * paths agree — but they agree by construction of the seed, not by a shared resolution. A tenant
 * that re-points `case-notes-pre-summary` at a different model would not move this call.
 * Closing it means giving the warm start the `resolveRealtimeTextAgent` path the flush uses,
 * which needs a text call that does not force the note's response format.
 *
 * ## NEVER THROWS
 *
 * `run` is contractually total, the same discipline as {@link ILiveAgentResolver}: any failure
 * yields `{ status: 'degraded' }` with a PHI-safe reason. The warm start is background for a
 * consultation that is already recording — a clinician must never be blocked from documenting
 * because the prior record could not be summarised.
 */

/** DI token for {@link ILivePreSummaryRunner}. */
export const ILivePreSummaryRunner = Symbol('ILivePreSummaryRunner');

export interface LivePreSummaryInput {
  readonly consultationId: string;
  readonly tenantId: string;
  /** The clinician who opened the session; `SummaryService` attributes the context item to them. */
  readonly userId?: string | null;
  /** The `agentRef.slug` the graph's warm-start node names — reported, see the seam note above. */
  readonly agentSlug: string | null;
}

export interface LivePreSummaryResult {
  readonly status: 'ready' | 'degraded';
  /** The generated pre-summary, on `ready`. */
  readonly content?: string;
  /**
   * A PHI-SAFE reason code on `degraded` — never clinical text, because it is published on the
   * clinician's live feed. `no_case_notes` is the ordinary one: a first-ever visit has no prior
   * record to summarise, and that is a fact about the patient, not a failure.
   */
  readonly reason?: string;
}

export interface ILivePreSummaryRunner {
  /** Run one warm start. NEVER rejects. */
  run(input: LivePreSummaryInput): Promise<LivePreSummaryResult>;
}
