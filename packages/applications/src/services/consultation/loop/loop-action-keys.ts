/**
 * The consultation loop's ACTION vocabulary and its structural validators.
 *
 * `ConsultationLoopWorkflow` dispatches actions by key; this is the closed list
 * of keys it will accept. It is mirrored by `LOOP_ACTION_KEYS` in
 * `apps/harness/src/harness/temporal/models.py` (asserted there to equal
 * `LOOP_ACTION_REGISTRY`), so the two must be changed together — a key that
 * exists here and not there looks configured and does nothing.
 *
 * Previously declared in `services/departmentAgent/constants.ts` as
 * `AGENT_ACTION_KEYS`. It moved here with the retirement of `DepartmentAgent`
 * the vocabulary describes the LOOP, not the agent row that used to
 * carry the two levers over it. Per the retirement's coupling table, the keys
 * and their validators travel with the endpoint sequence, which is the surface
 * that still consumes them (`endpoint-sequence.ts`).
 *
 * The NAME changed from `AGENT_ACTION_KEYS` to `LOOP_ACTION_KEYS` and the
 * CONTENT did not: the list is byte-identical to the one the Python mirror
 * asserts against, so renaming it here cannot move the parity assertion.
 */
export const LOOP_ACTION_KEYS = [
  'livedoc.start',
  'livedoc.stop',
  'vision.extract_text',
  'document.extract_text',
  'nlp.extract_entities',
  'harness.finalize',
  'client.emit',
  // the ENDPOINT STAGE. Part of this vocabulary, and not merely of the endpoint
  // sequence setting, because the endpoint resolver's EXTEND/VETO levers are expressed in these
  // keys. The endpoint resolver only accepts endpoint-eligible keys, so widening the vocabulary
  // here never widens the endpoint stage on its own.
  'session.timeout',
  'summary.finalize',
  'feedback.capture',
] as const;

export type LoopActionKey = (typeof LOOP_ACTION_KEYS)[number];

const LOOP_ACTION_KEY_SET: ReadonlySet<string> = new Set(LOOP_ACTION_KEYS);

/**
 * Structural validation of an action list: every entry must be a known action
 * key, a string, and non-duplicate.
 */
export function actionListProblems(value: unknown[], field: string): string[] {
  const problems: string[] = [];
  const seen = new Set<unknown>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !LOOP_ACTION_KEY_SET.has(entry)) {
      problems.push(`${field}[${index}] must be one of ${LOOP_ACTION_KEYS.join(', ')} (got ${JSON.stringify(entry)})`);
      return;
    }
    if (seen.has(entry)) {
      problems.push(`${field}[${index}]: duplicate action '${entry}'`);
      return;
    }
    seen.add(entry);
  });
  return problems;
}

/**
 * The one cross-field rule of a two-list compliance envelope: an action cannot
 * be both mandatory and forbidden at once.
 */
export function actionOverlapProblems(always: unknown[] | undefined | null, never: unknown[] | undefined | null): string[] {
  if (!always || !never) return [];
  const alwaysSet = new Set(always.filter((v): v is string => typeof v === 'string'));
  const overlap = never.filter((v): v is string => typeof v === 'string' && alwaysSet.has(v));
  if (overlap.length === 0) return [];
  return [`the following action(s) appear in both alwaysActions and neverActions: ${overlap.join(', ')}`];
}
