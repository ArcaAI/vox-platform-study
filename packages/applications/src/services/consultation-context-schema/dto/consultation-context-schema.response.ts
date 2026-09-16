import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationContextSchemaScope, ConsultationContextSchemaStatus, WorkflowDefinitionStatus } from '@arcaai/domains';
import type { DefinitionChangeClassification } from '../definition-diff';
import type { ContextSchemaBinding, ContextSchemaVerdict } from '../context-schema-usages';

/**
 * One consumer bound to a context schema, and what the version being published (or pinned) would
 * do to it. `verdict` is computed by the single pure rule in `context-schema-usages.ts` — the
 * console, this response and the publish gate all read that same answer.
 */
export class ContextSchemaWorkflowUsage {
  @ApiProperty() definitionId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty({ enum: WorkflowDefinitionStatus }) status: WorkflowDefinitionStatus;
  @ApiProperty({ description: 'Whether this is the version the dispatcher resolves for new runs.' })
  isActive: boolean;
  @ApiProperty({
    enum: ['latest', 'pinned'],
    description: '`latest` = the trigger re-reads the tenant pin at dispatch; `pinned` = it keeps the version it was published with.',
  })
  binding: ContextSchemaBinding;
  @ApiPropertyOptional({ nullable: true, description: 'The schema version this consumer was frozen at.' })
  boundVersion: number | null;
  @ApiProperty({ enum: ['accepts', 'refuses', 'unknown'] }) verdict: ContextSchemaVerdict;
  @ApiProperty({ type: [String], description: 'Empty unless the verdict is `refuses` or `unknown`.' })
  problems: string[];
}

export class ContextSchemaAgentUsage {
  @ApiProperty() agentId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty({ enum: WorkflowDefinitionStatus }) status: WorkflowDefinitionStatus;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ enum: ['latest', 'pinned'] }) binding: ContextSchemaBinding;
  @ApiPropertyOptional({ nullable: true }) boundVersion: number | null;
  @ApiProperty({ enum: ['accepts', 'refuses', 'unknown'] }) verdict: ContextSchemaVerdict;
  @ApiProperty({ type: [String] }) problems: string[];
}

/**
 * "Used by N workflows · M agents", with a verdict per consumer.
 *
 * Served by `GET admin/consultation-context-schemas/:id/usages` and embedded as `impact` on the
 * `publish` / `pin` responses — the same shape in both places, because an admin who previews the
 * impact and an admin who reads what a publish did must be looking at the same document.
 */
export class ContextSchemaUsagesResponse {
  @ApiProperty() schemaId: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The version the verdicts were computed against. Null only for a schema that has never been published.',
  })
  againstVersion: number | null;
  @ApiProperty({ type: [ContextSchemaWorkflowUsage] }) workflows: ContextSchemaWorkflowUsage[];
  @ApiProperty({ type: [ContextSchemaAgentUsage] }) agents: ContextSchemaAgentUsage[];
}

export class ConsultationContextSchemaResponse {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ enum: ConsultationContextSchemaScope }) scope: ConsultationContextSchemaScope;
  @ApiPropertyOptional({ nullable: true }) departmentId: string | null;
  @ApiProperty({ enum: ConsultationContextSchemaStatus }) status: ConsultationContextSchemaStatus;
  @ApiPropertyOptional({ nullable: true, description: 'The version discovery serves. Null until the first publish.' })
  pinnedVersionNumber: number | null;
  @ApiProperty() isDefault: boolean;
  @ApiPropertyOptional({ nullable: true }) sourceTemplateSlug: string | null;
  @ApiProperty() templateLocked: boolean;
  @ApiProperty({ description: 'Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor.' })
  version: number;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
  /**
   * What this write did to the schema's consumers, computed against the version being published
   * or pinned. Present on the `publish` and `pin` responses ONLY — a plain read does not pay for
   * two extra queries, and the standalone `:id/usages` route answers the same question on demand.
   *
   * On a publish it is the impact the caller ACCEPTED: a refusing active consumer is what the
   * `SCHEMA_IMPACT_UNACKNOWLEDGED` gate refuses, and the same document rides that refusal body.
   */
  @ApiPropertyOptional({ type: () => ContextSchemaUsagesResponse })
  impact?: ContextSchemaUsagesResponse;
}

export class ConsultationContextSchemaVersionResponse {
  @ApiProperty() id: string;
  @ApiProperty() schemaId: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) definition: Record<string, unknown>;
  @ApiProperty({ description: 'sha256 over the canonical JSON of `definition`.' }) checksum: string;
  @ApiPropertyOptional({ nullable: true }) changeReason: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy: string | null;
  @ApiProperty() createdAt: string;
  /**
   * Computes this classification (`classifyDefinitionChange`) but
   * previously only logged it (`ContextService`); surfaces it here so
   * an admin can see whether a client still pinned to this version would keep
   * working against the tenant's CURRENT pin. Set on every version except the
   * currently pinned one (nothing to compare it to) — absent when the schema
   * has no pin yet.
   */
  @ApiPropertyOptional({ enum: ['IDENTICAL', 'ADDITIVE', 'BREAKING'] })
  versionSkew?: DefinitionChangeClassification;
}

/**
 * The DISCOVERY bundle (/R2) — the resolved, pinned declaration a
 * client builds its workflow from.
 *
 * Every field is nullable because "this tenant has not configured a context
 * schema" is an ordinary, expected state that must NOT be reported as 404: a
 * 404 is indistinguishable from a routing mistake, and a client that cannot
 * tell those apart cannot decide whether to fall back to its built-in flow.
 */
export class ConsultationContextSchemaBundleResponse {
  @ApiPropertyOptional({ nullable: true }) schemaId: string | null;
  @ApiPropertyOptional({ nullable: true }) slug: string | null;
  @ApiPropertyOptional({ nullable: true }) name: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The PINNED version number — never simply the latest published one.' })
  versionNumber: number | null;
  @ApiPropertyOptional({ nullable: true }) contextSchemaVersionId: string | null;
  @ApiPropertyOptional({ nullable: true }) checksum: string | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true })
  definition: Record<string, unknown> | null;
  @ApiProperty({
    description:
      'Strong RFC 7232 validator over the SERVED representation (schema identity + pinned version + definition bytes). ' +
      'Unconfigured tenants get `"none"`. It moves only when what is served moves — editing the schema head row\'s ' +
      'name does not change it.',
  })
  etag: string;
}
