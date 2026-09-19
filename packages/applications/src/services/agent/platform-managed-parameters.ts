import { AGENT_PARAMETER_SCHEMAS, type AgentTask } from '@arcaai/workflow-contract';

/**
 * TASK-991 (owner decision OD-3, 2026-09-19) — PLATFORM-MANAGED agent parameters.
 *
 * > The speaker-embedding model used for voice feature extraction is FIXED for every tenant. No
 * > tenant may change it. It stays CONFIG rather than a literal — a PLATFORM admin owns it at the
 * > SYSTEM tier, so it is changed by editing a value, not by shipping a release.
 *
 * ─── Why this is a lock and not a validation rule ──────────────────────────────────────────
 *
 * A voice profile is an embedding in ONE model's vector space. Point an agent at a different
 * `SPEAKER_EMBEDDING` model and every profile the tenant's clinicians enrolled is still valid,
 * still stored, still returned — and no longer comparable to anything the runtime computes. There
 * is no error to surface: diarization simply never recognises anyone again. Locking the value
 * removes that whole failure class at the only point where it can be introduced, the write.
 *
 * ─── Why the SCHEMA decides, not a path list ───────────────────────────────────────────────
 *
 * The locked paths are DERIVED from `AGENT_PARAMETER_SCHEMAS` by walking for the standard JSON
 * Schema annotation `readOnly: true` (`@arcaai/workflow-contract`). One declaration, three
 * readers: the contract states it, this guard enforces it, and the console renders the field
 * disabled off the same keyword. A hardcoded `'audioFrontEnd.diarization.embeddingModelSlug'`
 * here would be a fourth place to keep in step, and the first to fall out of it.
 */

/** Dotted paths of every leaf a task's parameter schema marks `readOnly: true`. */
function collect(schema: Record<string, unknown>, prefix: readonly string[], into: string[]): void {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;
  for (const [name, child] of Object.entries(properties)) {
    const path = [...prefix, name];
    if (child.readOnly === true) into.push(path.join('.'));
    collect(child, path, into);
  }
}

const CACHE = new Map<AgentTask, readonly string[]>();

/**
 * The dotted parameter paths a tenant may not write for `task`, in schema order.
 * Empty for every task that declares no `readOnly` property — which is all of them but
 * `SPEECH_TO_TEXT` today.
 */
export function platformManagedParameterPaths(task: AgentTask): readonly string[] {
  const cached = CACHE.get(task);
  if (cached) return cached;
  const paths: string[] = [];
  const schema = AGENT_PARAMETER_SCHEMAS[task] as Record<string, unknown> | undefined;
  if (schema) collect(schema, [], paths);
  const frozen = Object.freeze(paths);
  CACHE.set(task, frozen);
  return frozen;
}

function valueAt(parameters: unknown, path: string): unknown {
  let cursor: unknown = parameters;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Which platform-managed paths `next` would CHANGE relative to `current`, dotted, in schema order.
 *
 * "Change" includes REMOVAL: dropping the key is not a no-op, it is the same silent breakage by
 * another route (the gateway then refuses the spec with 409 `ASR_AGENT_DIARIZATION_MODEL_MISSING`
 * instead of diarizing). An absent-in-both path, and a value written back unchanged, both pass —
 * so an ordinary edit to any OTHER parameter keeps working exactly as before.
 *
 * Compared through `JSON.stringify` rather than `!==` so a future object-valued platform-managed
 * property cannot be refused for being a different reference with identical contents.
 */
export function platformManagedParameterChanges(task: AgentTask, next: unknown, current: unknown): string[] {
  return platformManagedParameterPaths(task).filter((path) => {
    const before = valueAt(current, path);
    const after = valueAt(next, path);
    return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
  });
}
