import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentFindingResponse } from './agent.response';

/** What the bench resolved to run on, and how it got there. */
export class AgentTestTargetResponse {
  @ApiProperty({ description: 'The provider as apps/text registers it (`azure` → `azure-openai`).' }) provider!: string;
  @ApiProperty({ description: 'The provider-native model id that goes on the wire (`AiModel.sourceUri`).' }) model!: string;
  @ApiProperty({
    enum: ['platform', 'tenant'],
    description:
      'DERIVED, never stamped: `platform` when the credential that would serve this call comes from the SYSTEM tier, `tenant` when it is the caller’s own. This is the tier the run is billed against.',
  })
  fundingTier!: 'platform' | 'tenant';
  @ApiProperty({
    enum: ['row', 'override'],
    description: '`row` — the agent’s own bound model. `override` — a `{provider, model}` pair the caller supplied on this request.',
  })
  source!: 'row' | 'override';
}

/**
 * TASK-890 §3.8 — the answer to `POST /admin/agents/{id}/test`.
 *
 * ONE shape for both modes, discriminated by `mode`. A dry run carries everything except
 * `taskId` / `streamUrl`, because those only exist once something is actually generating: the
 * whole value of a dry run is that it answers "what would you have sent, and where?" without
 * spending a token.
 *
 * `findings` is the SAME `AgentFinding[]` the console already renders on validate and publish —
 * the bench compiles the draft through the identical `collectFindings` path, so a WARNING seen
 * here is the warning publish will report. A BLOCKING finding never reaches this response: it is
 * a 400 carrying the same list.
 */
export class AgentTestAckResponse {
  @ApiProperty({ enum: ['dry-run', 'stream'] }) mode!: 'dry-run' | 'stream';
  @ApiProperty({ type: [AgentFindingResponse], description: 'Non-blocking findings from compiling the draft in memory.' })
  findings!: AgentFindingResponse[];
  @ApiPropertyOptional({ nullable: true, description: 'The rendered system prompt, or null when the agent has none.' })
  assembledSystemPrompt!: string | null;
  @ApiProperty({ description: 'The rendered user prompt — exactly the bytes that would go to TEXT.' }) assembledUserPrompt!: string;
  @ApiProperty({ type: AgentTestTargetResponse }) resolved!: AgentTestTargetResponse;
  @ApiPropertyOptional({ description: 'Stream mode only — the TEXT generation id, and the handle `POST :id/test/finalize` takes.' })
  taskId?: string;
  @ApiPropertyOptional({ description: 'Stream mode only — the GATEWAY-relative SSE path (never a service-relative one).' })
  streamUrl?: string;
}
