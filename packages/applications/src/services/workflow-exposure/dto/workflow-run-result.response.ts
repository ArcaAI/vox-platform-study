import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-1038 D-I — what `GET /api/v1/workflows/:slug/runs/:runId/result` resolves a run's
 * delivered output to. The SERVICE answer; the controller renders it:
 *
 * - `inline` → `200`, the body IS the delivered JSON value (`X-Hope-Result-Kind: inline`);
 * - `ref` → `200`, a {@link WorkflowRunResultRefResponse} (`X-Hope-Result-Kind: ref`);
 * - `none` → `204` — the run ended and delivered nothing;
 * - `expired` → `410` — it delivered something, and `workflowRuns.resultRetentionDays` has passed.
 *
 * A run that is not terminal yet is a `409` (`RUN_NOT_TERMINAL`, with its current status), raised
 * by the service rather than encoded here.
 */
export type WorkflowRunResult =
  | { runId: string; status: string; kind: 'inline'; value: unknown }
  | ({ runId: string; status: string; kind: 'ref' } & WorkflowRunResultRefResponse)
  | { runId: string; status: string; kind: 'none' }
  | { runId: string; status: string; kind: 'expired'; expiredAt: string };

/** Body of the result route for a claim-checked (large) result: a short-lived signed GET URL. */
export class WorkflowRunResultRefResponse {
  @ApiProperty({ description: 'A short-lived signed GET URL for the result object. Do not log or share it: it is a bearer credential until it expires.' })
  url: string;

  @ApiProperty({ description: 'When `url` stops working (ISO-8601). Request the route again for a fresh one.' })
  expiresAt: string;

  @ApiProperty({ description: 'Size of the result object in bytes.' })
  sizeBytes: number;

  @ApiProperty({ description: 'SHA-256 (hex) of the result object, for an integrity check after download.' })
  sha256: string;
}

/** Machine-readable `code` of the 409 the result route answers while the run is still going. */
export const RUN_NOT_TERMINAL = 'RUN_NOT_TERMINAL';
