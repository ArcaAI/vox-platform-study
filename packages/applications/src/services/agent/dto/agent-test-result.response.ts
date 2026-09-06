import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentTestUsageResponse {
  @ApiProperty() promptTokens!: number;
  @ApiProperty() completionTokens!: number;
  @ApiProperty() totalTokens!: number;
}

/**
 * TASK-890 §3.8 — the answer to `POST /admin/agents/{id}/test/finalize`.
 *
 * The text is read back from TEXT **server-side** by `taskId` and is deliberately NOT accepted
 * from the request body: the browser watched the same tokens arrive over SSE, but trusting it to
 * hand them back would let any caller decide what the platform records about a run.
 *
 * Nothing is persisted on the agent row. A draft test is an authoring aid, not a version fact —
 * publishing is what writes to the lineage.
 */
export class AgentTestResultResponse {
  @ApiProperty({ description: 'The accumulated generation.' }) output!: string;
  @ApiProperty({ description: 'The provider that served it, as TEXT reports it.' }) provider!: string;
  @ApiProperty({ description: 'The provider-native model id that served it.' }) model!: string;
  @ApiPropertyOptional({ nullable: true, type: AgentTestUsageResponse, description: 'Token counts, when TEXT reported them.' })
  usage!: AgentTestUsageResponse | null;
}
