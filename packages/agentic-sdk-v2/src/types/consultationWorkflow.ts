/**
 * @arcaai/vox — consultation workflow DISCOVERY types.
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

/**
 * One entry of `GET /consultations/workflows` — a workflow that may be passed as
 * `OpenSessionInput.workflowDefinitionSlug`.
 *
 * Mirrors `SelectableConsultationWorkflowResponse`. Deliberately four fields: enough to render a
 * chooser, and nothing describing the graph itself — the route is reachable by callers holding
 * no workflow-definition ability at all. `paletteKey` is absent because it is `consultation` for
 * every entry by construction, and a version number is absent because selection is by slug,
 * which always resolves to whatever version is live.
 */
export interface SelectableConsultationWorkflow {
  /** The value to send as `workflowDefinitionSlug` when opening a consultation. */
  slug: string;
  name: string;
  description: string | null;
  /**
   * `true` for the slug the TENANT-level assignment names — what governs when no selection is
   * made. A department override can still win at open, so treat this as a sensible preselection
   * rather than a promise about a particular consultation.
   */
  isTenantDefault: boolean;
}
