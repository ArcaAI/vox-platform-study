// TASK-950 — pull the declared user-identity value out of a request's context payload.
//
// Pure and dependency-free ON PURPOSE: all three planes (consultation open, agent invocation,
// workflow run) shape their payload the same way — `{ [kindKey]: { [field]: value } }` — but
// they reach it through three different validators. One function means the three cannot drift
// on which property they read.

// The binding shape is lane B's canonical declaration; this helper only READS it, so the type is
// imported rather than restated (a second declaration would surface twice through the services
// barrel and TS2308 on the ambiguity).
import type { UserIdentityBinding } from '../../consultation-context-schema/context-schema-definition';

/**
 * The identity value carried by `payload`, or `undefined` when the request did not send one.
 *
 * `undefined` is the ONLY "absent" answer, and it deliberately covers the wrong-type case too.
 * That is not laxness: presence is governed by the schema's own `required` flags (plan D-2) and
 * TYPE is governed by the schema validator, both of which have already run and rejected the
 * request by the time this is called. A second, differently-worded refusal here would be a
 * competing validator — and the one thing worse than two validators is two validators that
 * disagree.
 */
export function extractUserIdentityValue(payload: Record<string, unknown> | undefined | null, binding: UserIdentityBinding): string | undefined {
  if (!payload) return undefined;

  const kind = payload[binding.kindKey];
  // Reject arrays explicitly: `typeof [] === 'object'`, and a MANY-cardinality kind arrives as
  // an array whose `['field']` is always undefined — the guard states the intent rather than
  // relying on that accident.
  if (typeof kind !== 'object' || kind === null || Array.isArray(kind)) return undefined;

  const value = (kind as Record<string, unknown>)[binding.field];
  return typeof value === 'string' ? value : undefined;
}
