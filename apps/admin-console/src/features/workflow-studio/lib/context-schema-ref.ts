/**
 * `core.trigger`'s `config.contextSchema` binding (TASK-890 §3.4, `node-config-schemas.ts`'s
 * `CORE_TRIGGER_SCHEMA.properties.contextSchema`): an inline JSON Schema OR a REFERENCE onto one
 * of the tenant's own `ConsultationContextSchema` rows, never both. Mirrors the two-key
 * "document binding" pattern (`document-binding.ts`) for the same reason: the generic
 * `toFieldDescriptors` renderer draws the reference as a free-text UUID box and a bare number
 * box (`ROW_REFERENCE_PROPERTY` + a plain integer), which is unreachable-by-slug and offers no
 * way to see the tenant's own schemas or which versions exist — `ContextSchemaRefField` reads
 * and writes through these pure helpers instead.
 *
 * Kept separate from `inline` on purpose: switching TO a reference clears any inline schema
 * (the two are mutually exclusive on the wire — `CORE_TRIGGER_SCHEMA`'s `contextSchema` has no
 * cross-field constraint of its own, so the mutual exclusivity is an authoring convention this
 * module enforces, matching `templateReferenceSeverity`'s "reference wins" precedent).
 */

export const CONTEXT_SCHEMA_ID_KEY = 'contextSchemaId';
export const CONTEXT_SCHEMA_VERSION_KEY = 'versionNumber';
export const CONTEXT_SCHEMA_INLINE_KEY = 'inline';

export type ContextSchemaMode = 'inline' | 'reference';

export interface ContextSchemaBinding {
  mode: ContextSchemaMode;
  schemaId: string | null;
  /** `null` means "follow the schema's own pin" (the schema's `pinnedVersionNumber`), never a version 0. */
  versionNumber: number | null;
  inline: Record<string, unknown> | null;
}

function isPin(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the `contextSchema` sub-object off a `core.trigger` node's config. A present
 *  `contextSchemaId` wins — that is the REFERENCE mode; otherwise any `inline` schema is
 *  authored inline; an empty/absent object is `reference` mode with nothing chosen yet, which
 *  keeps the picker (rather than a raw-JSON editor) as the default surface for a fresh node. */
export function readContextSchemaBinding(config: Record<string, unknown>): ContextSchemaBinding {
  const raw = config.contextSchema;
  const obj = isPlainObject(raw) ? raw : {};
  const schemaId = typeof obj[CONTEXT_SCHEMA_ID_KEY] === 'string' && (obj[CONTEXT_SCHEMA_ID_KEY] as string).length > 0 ? (obj[CONTEXT_SCHEMA_ID_KEY] as string) : null;
  const inline = isPlainObject(obj[CONTEXT_SCHEMA_INLINE_KEY]) ? (obj[CONTEXT_SCHEMA_INLINE_KEY] as Record<string, unknown>) : null;
  const versionNumber = isPin(obj[CONTEXT_SCHEMA_VERSION_KEY]) ? (obj[CONTEXT_SCHEMA_VERSION_KEY] as number) : null;
  return { mode: schemaId !== null ? 'reference' : inline !== null ? 'inline' : 'reference', schemaId, versionNumber, inline };
}

/** Switches mode, clearing whichever half does not apply — never leaves a stale reference
 *  behind an inline schema or vice versa. */
export function withContextSchemaMode(config: Record<string, unknown>, mode: ContextSchemaMode): Record<string, unknown> {
  const current = readContextSchemaBinding(config);
  if (mode === current.mode) return config;
  const next: Record<string, unknown> = mode === 'reference' ? {} : { [CONTEXT_SCHEMA_INLINE_KEY]: current.inline ?? {} };
  return { ...config, contextSchema: next };
}

export function withContextSchemaReference(config: Record<string, unknown>, schemaId: string | null): Record<string, unknown> {
  const current = readContextSchemaBinding(config);
  if (schemaId === null) return { ...config, contextSchema: {} };
  const keepVersion = current.schemaId === schemaId ? current.versionNumber : null;
  const next: Record<string, unknown> = { [CONTEXT_SCHEMA_ID_KEY]: schemaId };
  if (keepVersion !== null) next[CONTEXT_SCHEMA_VERSION_KEY] = keepVersion;
  return { ...config, contextSchema: next };
}

export function withContextSchemaVersion(config: Record<string, unknown>, versionNumber: number | null): Record<string, unknown> {
  const current = readContextSchemaBinding(config);
  const next: Record<string, unknown> = { [CONTEXT_SCHEMA_ID_KEY]: current.schemaId ?? '' };
  if (isPin(versionNumber)) next[CONTEXT_SCHEMA_VERSION_KEY] = versionNumber;
  return { ...config, contextSchema: next };
}
