/**
 * StreamScope decorator — TASK-263 / W0-1
 *
 * Attach to SSE-serving routes that are allowed to be opened with a single-use
 * `?ticket=<ticket>` query param (issued by `POST /auth/stream-ticket`).
 *
 * The `JwtAuthGuard` reads this metadata when a ticket is presented and
 * verifies that the ticket's stored scope equals `<namespace>:<paramValue>`,
 * where `paramValue` is read from the request route param named by `param`.
 *
 * Example:
 * ```ts
 * @Get(':jobId/stream')
 * @Sse()
 * @StreamScope({ namespace: 'consultation_job', param: 'jobId' })
 * streamJob(@Param('jobId') jobId: string): Observable<MessageEvent> { ... }
 * ```
 *
 * Routes WITHOUT `@StreamScope` cannot be opened via `?ticket=`; the guard
 * will reject the ticket with `401 Unauthorized`.
 */
import { SetMetadata } from '@nestjs/common';

export interface StreamScopeConfig {
  /** Namespace prefix that the issued ticket's scope must start with (e.g. `consultation_job`). */
  namespace: string;
  /** Route param name whose value forms the second segment of the scope (e.g. `jobId`). */
  param: string;
}

export const STREAM_SCOPE_METADATA = 'stream-scope';

export const StreamScope = (config: StreamScopeConfig) => SetMetadata(STREAM_SCOPE_METADATA, config);
