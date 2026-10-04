import { platformManagedPaths, type AgentTask } from '@arcaai/workflow-contract';

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

/**
 * The dotted parameter paths a tenant may not write for `task`, in schema order.
 *
 * TASK-1036 W2 / OD-11 — generalised from TASK-991's single `readOnly` path to the contract's
 * `platformManagedPaths(task)`: every leaf carrying `x-platformManaged` (everything outside
 * `TENANT_EDITABLE_PARAMETER_PATHS`) plus any carrying the older `readOnly` lock. The contract
 * walks its own schemas, so this module states no path and no walk of its own.
 */
export function platformManagedParameterPaths(task: AgentTask): readonly string[] {
  return platformManagedPaths(task);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasPath(parameters: unknown, path: string): boolean {
  let cursor: unknown = parameters;
  for (const key of path.split('.')) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

/**
 * TASK-1036 W2 — a tenant write that OMITS a platform-managed path keeps the STORED value.
 *
 * The tenant editor hides every platform-managed field ("Managed by the platform"), so its PATCH
 * carries only the tenant-editable paths. Treating that omission as a removal would refuse every
 * ordinary edit of a pre-W2 agent (which stores decoding / penalties / seed values), and dropping
 * the value would silently change behaviour the tenant never touched. Carrying it forward leaves
 * the stored value exactly as it was — the brief's "existing stored values are left untouched".
 *
 * Only an ABSENT key is carried; an explicit `null` is a value and is compared like any other, so
 * it is still refused as a change by `platformManagedParameterChanges`. Returns `next` itself when
 * nothing needed carrying, otherwise a copy — the caller's DTO is never mutated.
 */
export function carryForwardPlatformManagedParameters(task: AgentTask, next: unknown, current: unknown): unknown {
  const carried = platformManagedParameterPaths(task).filter((path) => hasPath(current, path) && !hasPath(next, path));
  if (carried.length === 0) return next;
  const out: Record<string, unknown> = isPlainObject(next) ? (structuredClone(next) as Record<string, unknown>) : {};
  for (const path of carried) {
    const keys = path.split('.');
    let cursor = out;
    for (const key of keys.slice(0, -1)) {
      // A non-object in the way (the tenant replaced a block with a scalar) is left to the schema
      // gate to refuse; the carry never overwrites a value the tenant did write.
      if (cursor[key] === undefined) cursor[key] = {};
      if (!isPlainObject(cursor[key])) return out;
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[keys[keys.length - 1]] = structuredClone(valueAt(current, path));
  }
  return out;
}
