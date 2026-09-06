import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * TASK-890 §3.8 — run a DRAFT agent once, without publishing it.
 *
 * The three payload halves mirror the §3.3 namespace exactly, so a prompt that works on the bench
 * works unchanged from `POST /agents/:slug/invocations`: `input` is validated against the agent's
 * `inputSchema` (`input.*`), `context` against its bound context schema (`context.*`), and
 * `variables` overlays the agent's own `instruction.variables` bindings as the caller's turn of
 * the bare-name namespace.
 */
export class TestAgentRequest {
  @ApiPropertyOptional({ description: 'The invocation body — validated against the agent’s `inputSchema`; reachable as `input.*`.', type: Object })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Bare-name variable overrides. Overlays the agent’s own `instruction.variables` bindings — the caller wins, as it does at invocation.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Consultation context — validated against the agent’s bound context schema when it pins one; reachable as `context.*` and `trigger.*`.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Override the resolved provider. Must be supplied together with `model`.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @ApiPropertyOptional({ description: 'Override the resolved provider-native model id. Must be supplied together with `provider`.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Default TRUE. A dry run assembles and returns the prompts and the resolved target and generates NOTHING — no job, no tokens, no quota. Pass `false` to actually run it.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** The second half of the two-call bench: read the finished generation back by task id. */
export class FinalizeAgentTestRequest {
  @ApiProperty({ description: 'The `taskId` the stream acknowledgement returned.' })
  @IsString()
  @IsNotEmpty()
  taskId!: string;
}
