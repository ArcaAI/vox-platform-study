import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One entry of `GET /api/v1/consultations/workflows` — a workflow this caller may
 * name in `OpenConsultationRequest.workflowDefinitionSlug`.
 *
 * ## Deliberately four fields
 *
 * Enough to CHOOSE, and nothing else. No graph, no compiled configuration, no node inventory,
 * no row id, no version id: this route is reachable by a clinician-facing integration that holds
 * no `WorkflowDefinition` ability at all (see the route's AUTH-NOTE), so it must describe the
 * options without describing the machinery. `paletteKey` is omitted because it is `consultation`
 * for every entry by construction — printing a constant would only invite a client to filter on
 * it and re-implement the server's predicate.
 *
 * `versionNumber` is omitted for the same reason its sibling `ConsultationWorkflowResponse` names
 * its own field `activeVersionNumber`: the active published version is a MOVABLE pointer, so a
 * number here would be stale the moment the tenant republishes and is not something a caller
 * chooses between — selection is by slug, and the slug always resolves to whatever is live.
 */
export class SelectableConsultationWorkflowResponse {
  @ApiProperty({ description: 'The value to send as `workflowDefinitionSlug` when opening a consultation.' })
  slug: string;

  @ApiProperty({ description: 'Human-readable name of the definition.' })
  name: string;

  @ApiPropertyOptional({ nullable: true, description: 'Free-text description, when the author wrote one.' })
  description: string | null;

  /**
   * TENANT-level, and the name says so. The real cascade is
   * `department override → tenant default → platform default`, so a consultation opened for a
   * department that overrides the tenant will be governed by the department's choice instead.
   * This route takes no `departmentId` (it would be a caller-supplied cross-aggregate reference
   * on a read that otherwise needs none), so it answers the tier it can answer honestly.
   */
  @ApiProperty({
    description:
      "True for the slug the tenant-level assignment names — what governs when no selection is made. A department override can still win at open, so this is the TENANT default, not a promise about a particular consultation. At most one entry carries `true`, and none does when the tenant's assignment names something that is not itself selectable.",
  })
  isTenantDefault: boolean;
}

/** The tenant's selectable set. Empty is a real, non-error answer: the tenant has authored none. */
export class SelectableConsultationWorkflowListResponse {
  @ApiProperty({ type: [SelectableConsultationWorkflowResponse] })
  data: SelectableConsultationWorkflowResponse[];
}
