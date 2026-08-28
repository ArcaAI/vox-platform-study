/**
 * TASK-812 (D-10) — the CONSULTATION ENDPOINT SEQUENCE, read and written from the Studio.
 *
 * The sequence is a `global-kv` setting (`consultation.endpoint.actions`, `maxScope: 'tenant'`),
 * not a `WorkflowDefinition` field, so this file addresses `admin/settings/registry/*` rather
 * than `admin/workflow-definitions/*`. Two consequences worth stating, because both look like
 * mistakes until you know why:
 *
 * 1. **It lives in `workflow-studio`, not in `settings-registry`.** Features never import each
 *    other (rule 13 §Structure), and this is a Studio affordance — an admin ordering the stage
 *    that closes a consultation is doing workflow authoring, not settings administration. The
 *    generic key/value editor in `/settings-registry` still edits the same key; what this adds is
 *    an ORDERING surface, which a `string[]` textarea cannot be.
 * 2. **The write is conditionally preconditioned.** The registry PUT is a create-or-update
 *    carrying `@NoOptimisticConcurrency`: with no stored row there is no version to echo, so the
 *    `If-Match` is omitted; once a row exists, omitting it is refused 428 and a stale one 412.
 *    `versionFromEtag(...) > 0` is the test — a version of 0 means "no stored row".
 */

import { getWithEtag, putWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';

/** The descriptor key. Mirrors `CONSULTATION_ENDPOINT_ACTIONS_KEY`. */
export const ENDPOINT_SEQUENCE_KEY = 'consultation.endpoint.actions';

/**
 * The closed set of actions the sequence may contain, mirroring `ENDPOINT_ELIGIBLE_ACTIONS` in
 * `packages/applications/.../loop/endpoint-sequence.ts`.
 *
 * A client-side reflection, kept in sync by hand — the console never imports a server package.
 * The server remains the sole authority: this list only stops the picker OFFERING a value the
 * resolver would silently drop.
 */
export const ENDPOINT_ACTION_KEYS = ['livedoc.stop', 'session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture'] as const;

export type EndpointActionKey = (typeof ENDPOINT_ACTION_KEYS)[number];

export const ENDPOINT_ACTION_LABELS: Record<EndpointActionKey, string> = {
  'livedoc.stop': 'Stop live documentation',
  'session.timeout': 'Record how the session ended',
  'harness.finalize': 'Generate the clinical note',
  'summary.finalize': 'Lock every document',
  'feedback.capture': 'Capture clinician feedback',
};

/** One-line rationale per step, shown under the label so an ordering decision is informed. */
export const ENDPOINT_ACTION_HINTS: Record<EndpointActionKey, string> = {
  'livedoc.stop': 'Closes the audio session. Skipped automatically when the consultation never streamed audio.',
  'session.timeout':
    'Stamps whether the session ended normally or reached its idle bound — a note from a timed-out consultation must be identifiable as one.',
  'harness.finalize': 'Runs the note-generation workflow and queues the result for clinician review.',
  'summary.finalize': 'Locks EVERY document of the consultation, not just the SOAP note. Place it after the step that writes the note.',
  'feedback.capture':
    'Records clinician feedback and promotes any correction they accepted. The only path that can. Place it last — a feedback failure must never cost a finalized note.',
};

/**
 * True when the sequence would LOCK the consultation's documents before the step that writes the
 * note into them — `summary.finalize` ahead of `harness.finalize`.
 *
 * The twin of `endpointOrderProblem` in
 * `packages/applications/src/services/consultation/loop/endpoint-sequence.ts`, which the settings
 * write lane enforces through the descriptor's `validate`. Duplicated by hand for the same reason
 * `ENDPOINT_ACTION_KEYS` above is: the console never imports a server package, and a rule this
 * small is better copied than dragged across that boundary. This copy is ADVISORY — it warns
 * before the admin saves; the server is what refuses. Change one, change the other.
 *
 * Conditional on both being present, exactly as the server rule is: an admin who drops
 * `harness.finalize` entirely is making a legitimate choice, not a mistake to warn about.
 */
export function isEndpointOrderInverted(sequence: readonly string[]): boolean {
  const writesTheNote = sequence.indexOf('harness.finalize');
  const locksDocuments = sequence.indexOf('summary.finalize');
  return writesTheNote !== -1 && locksDocuments !== -1 && locksDocuments < writesTheNote;
}

/** The gateway's effective-value envelope for one key (subset this editor reads). */
export interface EndpointSequenceSetting {
  key: string;
  value: unknown;
  source: 'tenant' | 'system' | 'code-default';
}

const path = `admin/settings/registry/${encodeURIComponent(ENDPOINT_SEQUENCE_KEY)}`;

export function getEndpointSequence(scope: 'system' | 'tenant'): Promise<WithEtag<EndpointSequenceSetting>> {
  return getWithEtag(path, { scope });
}

export function putEndpointSequence(value: string[], scope: 'system' | 'tenant', etag: string | null): Promise<unknown> {
  const body = { value, scope };
  const usable = etag && versionFromEtag(etag) > 0 ? etag : null;
  return usable ? putWithEtag(path, body, usable) : request(path, { method: 'PUT', body });
}
