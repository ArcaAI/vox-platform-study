/**
 * The RUN-IDENTITY keys a caller may never put in a workflow `input`
 * (TASK-850).
 *
 * ## Why the SDK refuses what the gateway already refuses
 *
 * The gateway answers 400 for any of these, and that 400 is correct and
 * sufficient for safety. This list exists for a different reason: **a 400 is
 * a poor teacher**. An integrator who writes
 *
 * ```ts
 * hope.consultations.workflows.run(id, 'note-writer', { input: { consultationId: id } })
 * ```
 *
 * is doing the natural thing — restating in the body what they just put in the
 * URL. Discovering that as an HTTP 400 means a round trip, a log line, and a
 * guess about which of several fields the server disliked. Refusing here, with
 * every offending key named, turns it into a synchronous programming error at
 * the call site.
 *
 * ## Why it must not be *inferred*
 *
 * These are the keys the INTERPRETER reads as identity
 * (`run_identity(...)` in the harness). The gateway keeps its list
 * byte-identical to the harness's `RESERVED_RUN_IDENTITY_KEYS`, and this
 * module keeps a third copy in sync with a test that reads
 * `exposure-palette-policy.ts` off disk
 * (`resources/__tests__/workflows.contract.task850.test.ts`). Three spellings
 * of one list is otherwise an SDK that cheerfully sends a key the server then
 * refuses — or, worse, one it silently strips.
 *
 * The failure this prevents is not a 400. It is the one the gateway's own doc
 * names: a caller sends `{"consultationId": "..."}`, gets a 202, and believes
 * it addressed that consultation while the run acted on something else. The
 * gateway REFUSES rather than drops for that reason, and so does this.
 */

/**
 * Verbatim mirror of `RESERVED_RUN_IDENTITY_KEYS` in
 * `packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts`,
 * itself a mirror of the harness's own list. Order is preserved so a diff
 * against either source is a plain equality check.
 */
export const RESERVED_RUN_IDENTITY_KEYS: readonly string[] = Object.freeze(['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']);

/**
 * The reserved keys present in `input`, in the order this list declares them
 * — empty when the input is clean.
 *
 * Uses `hasOwnProperty` rather than `key in input` (an inherited `userId` on a
 * caller's prototype is not something they SENT) and rather than a truthiness
 * check (`{ consultationId: undefined }` still serializes the key's intent and
 * the gateway still sees the property).
 */
export function reservedRunIdentityKeysIn(input: Record<string, unknown> | undefined | null): string[] {
  if (input === null || input === undefined || typeof input !== 'object') return [];
  return RESERVED_RUN_IDENTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
}
