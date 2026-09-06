import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One entry of `GET /api/v1/workflows` — the tenant's published, invokable workflows.
 *
 * TASK-890 §3.9: it carries the definition's I/O CONTRACT as well as its identity. The
 * `core` vocabulary declares one (`core.trigger.contextSchema.inline`, `core.output.
 * outputSchema` / `protocols`, `core.trigger.kinds`) and `describeWorkflow` has been
 * computing it per definition since TASK-864 — so the catalogue answers it too, from the
 * SAME `declaredIoSchemas` / `declaredOutputProtocols` / `declaredTriggerKinds` readers.
 * One list read is then enough to generate a client; the alternative was an N+1 fan-out over
 * `GET {slug}/schema`, and two computations of the same fact that could drift.
 *
 * A LEGACY (non-`core`) graph declares none of it. That answers `null` / `[]` — never an
 * invented open `object` schema, which would tell an integrator a contract exists where the
 * substrate has none. (`GET {slug}/schema` DOES substitute an open schema, because an
 * OpenAPI `components.schemas` entry must be a schema; a catalogue field has no such
 * obligation and stays honest.)
 */
export class WorkflowSummaryResponse {
  @ApiProperty({ description: 'The public URL segment: /api/v1/workflows/:slug/…' })
  slug: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  paletteKey: string;

  @ApiProperty({ description: 'The ACTIVE published version number currently resolved for this slug.' })
  versionNumber: number;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: "JSON Schema of the run `input` — the Trigger's inline context schema. `null` when the definition declares none.",
  })
  inputSchema: Record<string, unknown> | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: "JSON Schema of what the run delivers — the Output's `outputSchema`. `null` when the definition declares none.",
  })
  outputSchema: Record<string, unknown> | null;

  @ApiProperty({
    type: [String],
    description: 'Output protocols the definition publishes (`http`, `http-sse`, `socket`, …) — what bounds `?mode=`. `[]` for a legacy graph (unrestricted).',
  })
  protocols: string[];

  @ApiProperty({
    type: [String],
    description: 'Trigger kinds the definition accepts (`api`, `webhook`, `schedule`, …). `[]` for a legacy graph (treated as `api`).',
  })
  triggerKinds: string[];
}

export class WorkflowSummaryListResponse {
  @ApiProperty({ type: [WorkflowSummaryResponse] })
  data: WorkflowSummaryResponse[];
}
