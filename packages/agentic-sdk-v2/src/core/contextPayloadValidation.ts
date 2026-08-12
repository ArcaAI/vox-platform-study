/**
 * @arcaai/vox - Client-side context payload validation (TASK-665)
 *
 * `useArcaSession().addContext()` calls `validateConsultationContextPayload`
 * BEFORE sending a `kindKey` + `payload` write, so a caller gets an immediate,
 * client-side error for a payload that clearly does not conform to the
 * tenant's declared `STRUCTURED` kind — without waiting on a round trip.
 *
 * ## Why the evaluator is shared, not `valibot`, and not a local copy
 *
 * The schema being evaluated (`kind.fields`) is TENANT-AUTHORED at runtime,
 * not a shape known at SDK build time, so there is nothing for `valibot` (a
 * static-schema builder) to compile against. A general-purpose JSON Schema
 * library would also accept keywords the server's AUTHORING gate forbids
 * (`if`/`then`/`else`, undiscriminated `oneOf`), so validating with one here
 * would let the client silently accept payload shapes the server never would
 * — worse than not validating client-side at all.
 *
 * This module therefore delegates to `@arcaai/json-schema-subset`, which is
 * the SINGLE implementation of the rule and is what the server enforces with.
 * It was previously a hand-maintained port of that code; two copies of one
 * clinical validation rule drift, and the drift is silent in both directions.
 * The package is dependency-free and is bundled into this SDK (see
 * `bundledDependencies` in `tsup.config.ts`), so sharing it costs the policed
 * bundle nothing.
 *
 * This module validates a VALUE against an authored schema; it does not
 * re-validate the AUTHORED schema itself (`authorableJsonSchemaProblems`) —
 * the schema only ever arrives here already published (and therefore already
 * past that gate) via the discovery bundle.
 */

import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';

import type { ConsultationSchemaBundle } from '../types/consultationSchema';
import { findConsultationContextKind } from '../types/consultationSchema';

/**
 * Problems with a submitted VALUE against an authored (server-published)
 * JSON Schema subset document. Empty means the payload conforms.
 *
 * Retained as the SDK's name for the shared evaluator: it is part of this
 * package's surface, and the name says what it is used for here.
 */
export const contextPayloadProblems = jsonSchemaValueProblems;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ContextPayloadValidationResult {
  valid: boolean;
  problems: string[];
}

/**
 * Validate a `{ kindKey, payload }` pair the caller is about to send in
 * `addContext()` against the SESSION-PINNED schema bundle.
 *
 * Deliberately permissive on anything it cannot resolve — this is a
 * fast-fail UX aid, never the source of truth:
 *  - No bundle, or the bundle's definition doesn't declare `kindKey` →
 *    `{ valid: true, problems: [] }`. The kind may be genuinely unknown to
 *    THIS build of the SDK (a tenant published it after the client shipped)
 *    — rejecting locally would break a client that is one release behind,
 *    which is exactly the forward-compatibility guarantee TASK-654 requires.
 *    The server is always the final authority and validates independently.
 *  - A resolved kind with no `fields` (non-`STRUCTURED`, or `payload`
 *    omitted) → nothing to validate against.
 */
export function validateConsultationContextPayload(
  bundle: ConsultationSchemaBundle | null | undefined,
  kindKey: string,
  payload: Record<string, unknown> | undefined,
): ContextPayloadValidationResult {
  const kind = findConsultationContextKind(bundle?.definition, kindKey);
  if (!kind || !isPlainObject(kind.fields) || payload === undefined) {
    return { valid: true, problems: [] };
  }
  const problems = contextPayloadProblems(kind.fields, payload);
  return { valid: problems.length === 0, problems };
}
