/**
 * TASK-949 L1 — the shared walk over `AGENT_PARAMETER_SCHEMAS[task]`.
 *
 * Extracted verbatim from `features/agents/components/parameters-form.tsx`, which now imports
 * them from here. Two renderers read the same per-task contract — the agents screen's EDITOR and
 * the workflow studio's read-only VIEW — and a feature may not import another feature
 * (`13-nextjs-apps.md` §Structure), so the shared half lives in `shared/`.
 *
 * Only the walk is shared, not a renderer: an editor emits controls and a view emits values, and
 * forcing one component to do both is how a read-only mode becomes a pile of disabled inputs.
 */
export type Schema = Record<string, unknown>;
export type Value = Record<string, unknown>;

/** A schema node's declared properties, or `{}` — never `undefined`, so callers can iterate freely. */
export function props(schema: Schema): Record<string, Schema> {
  return (schema.properties as Record<string, Schema> | undefined) ?? {};
}

/** `partialIntervalMs` -> `Partial interval ms`. The JSON key is the label of record. */
export function labelOf(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

export function getPath(value: Value, path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Value)[key];
  }
  return cursor;
}

/** Immutable set; deletes the key (and empty parents) when `next` is undefined so untouched knobs stay absent. */
export function setPath(value: Value, path: string[], next: unknown): Value {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy: Value = { ...value };
  if (rest.length === 0) {
    if (next === undefined || next === '') delete copy[head];
    else copy[head] = next;
    return copy;
  }
  const child = setPath(((copy[head] as Value | undefined) ?? {}) as Value, rest, next);
  if (Object.keys(child).length === 0) delete copy[head];
  else copy[head] = child;
  return copy;
}

/** A schema node that carries its own properties — rendered as a group, not a leaf. */
export function isGroup(schema: Schema): boolean {
  return schema.type === 'object' && Object.keys(props(schema)).length > 0;
}
