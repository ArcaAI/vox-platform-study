import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { GoverningRunSummary } from '../../governing-engine';

/**
 * `GET /api/v1/consultations/:id/workflow` — WHICH engine governs a
 * consultation, and the identity of the tenant-authored graph when one does.
 *
 * ## Why this route exists
 *
 * The decision was already durable and already load-bearing —
 * `ConsultationWorkflowDispatchService` writes it to `Consultation.metadata`
 * at open and `LoopContextSignalService` reads it before every signal — but
 * NOTHING returned it. A client could select a workflow and had no way to learn
 * whether the selection took effect, or whether dispatch silently degraded to
 * the default loop (which it does, by design, on a harness outage). That gap is
 * what this closes.
 *
 * ## `inputSchema` is `null`, and that is the honest answer
 *
 * There is no per-definition input schema ANYWHERE in the substrate to return.
 * `WorkflowDefinition` has no input column (`workflow-definition.prisma`),
 * `CompiledWorkflowConfig` has no input section (`compiler.ts`), and
 * `WorkflowSummaryResponse` / `InvokeWorkflowRequest` both say so in their own
 * doc comments. The field is declared and permanently `null` rather than
 * omitted so that DECLARING one later is an additive change to a contract
 * clients already read, instead of a new field they must discover.
 *
 * Note also that a consultation-governing graph takes no caller input at all:
 * the interpreter payload is server-constructed
 * (`{ consultationId, userId, externalPatientId }`). So even once definitions
 * declare schemas, this field describes the DEFINITION, not something the
 * `open` call should start carrying.
 */
export class ConsultationWorkflowResponse {
  @ApiProperty({ description: 'The consultation this answer is about.' })
  consultationId: string;

  @ApiProperty({
    description:
      'True when a tenant-authored `consultation`-palette workflow governs this consultation (Substrate B). False means the default consultation loop governs (Substrate A) — the platform default, and what every consultation with no assignment and no selection gets.',
  })
  governed: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Slug of the governing definition; null when the default loop governs.' })
  workflowDefinitionSlug: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The interpreter run that took ownership of this consultation.' })
  workflowRunId: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'When the governing decision was taken, ISO-8601.' })
  decidedAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Human-readable name of the governing definition; null if it is no longer published.' })
  name: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Free-text description of the governing definition.' })
  description: string | null;

  @ApiPropertyOptional({ nullable: true, description: "The governing definition's palette — `consultation` for anything that can govern." })
  paletteKey: string | null;

  /**
   * Deliberately NOT called `versionNumber`. The active published version is a
   * MOVABLE pointer, so a republish since this consultation opened would make
   * a field named `versionNumber` read as "the version that ran" when it is
   * not. `WorkflowRun` carries no consultation linkage to join the actual
   * version back through (see `governing-engine.ts`), so the honest field is
   * the one whose name says which version it is.
   */
  @ApiPropertyOptional({
    nullable: true,
    description: "The slug's CURRENTLY active published version — not necessarily the version that ran, if the tenant has republished since.",
  })
  activeVersionNumber: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Always null: no per-definition input schema is declared anywhere in the substrate yet. See the class doc.',
  })
  inputSchema: Record<string, unknown> | null;

  /**
   * The governing run itself — the same object `ConsultationResponse.governingRun` carries, from
   * the same derivation.
   *
   * The four fields above it (`workflowDefinitionSlug`, `workflowRunId`, `decidedAt`, `governed`)
   * describe the DECISION and stay exactly as they were. This describes the RUN, and it is a
   * separate object rather than four more sibling fields because the two facts have different
   * lifetimes: the decision is fixed at open, the run's status moves.
   */
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'The governing run and its status, or null when the default loop governs. Identical to `ConsultationResponse.governingRun` — one derivation, so the two routes can never disagree.',
  })
  run: GoverningRunSummary | null;
}
