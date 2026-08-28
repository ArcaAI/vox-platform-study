/**
 * @arcaai/vox — consultation workflow DISCOVERY types (TASK-813).
 *
 * Mirrors `ConsultationWorkflowResponse` from
 * `GET /consultations/:id/workflow`. See that DTO for why `inputSchema` is
 * declared and permanently `null` (no per-definition input schema is declared
 * anywhere in the substrate yet) and why the version field is named
 * `activeVersionNumber` rather than `versionNumber`.
 */
export interface ConsultationWorkflow {
  /** The consultation this answer is about. */
  consultationId: string;
  /**
   * `true` when a tenant-authored `consultation`-palette workflow governs this
   * consultation. `false` means the platform's default consultation loop does —
   * the outcome for a tenant that has authored nothing, and also the fallback
   * when dispatching a SELECTED workflow could not proceed (dispatch is
   * best-effort by design so a harness outage never blocks an open).
   */
  governed: boolean;
  /** Slug of the governing definition; `null` under the default engine. */
  workflowDefinitionSlug: string | null;
  /** The interpreter run that took ownership of this consultation. */
  workflowRunId: string | null;
  /** When the governing decision was taken, ISO-8601. */
  decidedAt: string | null;
  /** Human-readable name; `null` if the definition is no longer published. */
  name: string | null;
  description: string | null;
  paletteKey: string | null;
  /**
   * The slug's CURRENTLY active published version — NOT necessarily the version
   * that ran, if the tenant has republished since this consultation opened.
   */
  activeVersionNumber: number | null;
  /** Always `null` today — the substrate declares no per-definition input schema. */
  inputSchema: Record<string, unknown> | null;
}
