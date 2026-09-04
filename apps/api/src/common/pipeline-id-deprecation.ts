import type { Response } from 'express';

/**
 * TASK-861 — the deprecated `pipelineId` request path answers with the
 * program-wide deprecation headers (RFC 9745 `Deprecation` + an operator-
 * readable notice + the successor link). ONE literal, shared by every route
 * that still honours `pipelineId` for the window — `POST audio/transcription-jobs/
 * stream/session`, `POST …/transcribe` and the v1-compat `POST api/stt/start_session`
 * — so the three cannot drift. Set per request because each of those routes
 * serves BOTH paths; `@ApiDeprecated` is a per-route marker and would mislabel
 * the agent path. No `Sunset` until the removal tags are named (OD-2).
 */
export function markPipelineIdDeprecated(res?: Response): void {
  res?.setHeader('Deprecation', 'true');
  res?.setHeader('X-Deprecation-Notice', 'TASK-861 — `pipelineId` is removed in R4; send `agentSlug` (or nothing, for the assigned ASR agent)');
  res?.setHeader('Link', '</api/v1/agents?task=SPEECH_TO_TEXT>; rel="successor-version"');
}
