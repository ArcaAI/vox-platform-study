/**
 * PHI on the Test tab (TASK-1036 §10.2 "Privacy"): values are shown to admins by default — the
 * gateway audits every trace read — and one click hides them. Hiding replaces VALUES only; labels,
 * paths, codes, statuses and counts are not patient data and stay readable.
 */
export const PHI_MASK = '•••';

/** Keys whose values describe the run, not the patient — kept when a payload is masked. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'seq',
  'runId',
  'type',
  'ts',
  'nodeId',
  'kind',
  'slug',
  'versionNumber',
  'mode',
  'status',
  'durationMs',
  'tokens',
  'in',
  'out',
  'degraded',
  'reason',
  'label',
  'attempt',
  'warnings',
  'willRetry',
  'code',
  'message',
  'field',
  'visibility',
  'format',
  'sampleRate',
  'valid',
  'input',
  'source',
  'path',
  'template',
  'empty',
  'phiClass',
  'consultationId',
  'snapshot',
  'utteranceIndex',
  'stableChars',
  'start',
  'end',
  'speaker',
  'language',
  'name',
  'chars',
  'charsTotal',
  'tokensTotal',
  'selected',
  'excluded',
  'blocks',
  'key',
  'truncated',
  'composedPromptId',
  'provider',
  'model',
  'fallback',
  'stream',
  'parameters',
  'temperature',
  'maxTokens',
  'action',
  'detected',
  'categories',
  'latencyMs',
]);

/** A deep copy with every non-structural leaf value replaced by the mask. */
export function maskPayload(value: unknown, key?: string): unknown {
  if (key !== undefined && STRUCTURAL_KEYS.has(key) && (typeof value !== 'object' || value === null)) return value;
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, maskPayload(entry, entryKey)]));
  }
  return value === undefined || value === null ? value : PHI_MASK;
}
