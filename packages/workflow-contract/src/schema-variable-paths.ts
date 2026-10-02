/**
 * The concrete prompt paths a consultation context schema offers — ONE derivation, shared by the
 * publish gate and the console's completion list, so "what the editor suggests" and "what publish
 * accepts" cannot disagree.
 *
 * Input is a `ConsultationContextSchemaVersion.definition` (`{ schemaVersion, kinds, outputs }`).
 * The derivation follows the payload schema the gateway validates a run against
 * (`payloadSchemaFromDefinition`):
 *
 *  - one entry per declared KIND, `<root>.<kindKey>`; its `type` is the kind's platform primitive
 *    (`STRUCTURED`, `TEXT`, `DOCUMENT`, `IMAGE`, `STREAM_AUDIO`);
 *  - a `STRUCTURED` kind additionally contributes each top-level property of its `fields` schema,
 *    `<root>.<kindKey>.<field>`; its `type` is the field's JSON Schema `type` (a union joined with
 *    `|`, `any` when undeclared);
 *  - `outputs` are ignored — an output is produced BY the run, never supplied to it.
 *
 * The SOLE-KIND COLLAPSE (the gateway's `soleContextKindSchema`): when `root === 'context'` and
 * the definition declares exactly one kind, keyed `context`, the kind IS the context — the render
 * scope binds the kind's own object under `context` — so its fields are offered as
 * `context.<field>` and the kind entry itself is not. Under `trigger` the envelope is kept
 * (`trigger.context.<field>`), because on a workflow lane that root IS the validated run payload.
 *
 * Per entry: `required` is the kind's `required: true` (a kind) or membership of the kind schema's
 * `required` list (a field); `phiClass` is the KIND's (`PHI` / `NON_PHI`) and is inherited by its
 * fields — the definition declares PHI per kind, not per field; `deprecated` is a kind's
 * `deprecated` block, or a field's JSON Schema `deprecated: true`, or the field's kind being
 * deprecated; `description` is the kind's or field's own, else `null`.
 *
 * An INLINE trigger schema (a JSON Schema already in payload shape, no `kinds`) is read the same
 * way one level deep, with no PHI class — it declares none.
 *
 * Sorted by path in code-unit order (never a locale), and TOTAL: anything unreadable yields `[]`.
 * Mirrored in Python by `schema_variable_paths.py`, held to
 * `tests/contracts/schema-variable-paths.fixture.json`.
 */

export interface SchemaVariablePath {
  readonly path: string;
  readonly type: string;
  readonly required: boolean;
  readonly phiClass: string | null;
  readonly description: string | null;
  readonly deprecated: boolean;
}

/** The kind key that collapses into the `context` root when it is the only kind. */
const SOLE_CONTEXT_KIND_KEY = 'context';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jsonType(schema: Record<string, unknown> | undefined): string {
  const type = schema?.type;
  if (typeof type === 'string' && type.length > 0) return type;
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (names.length > 0) return names.join('|');
  }
  return 'any';
}

function requiredNames(schema: Record<string, unknown> | undefined): Set<string> {
  const required = schema?.required;
  return new Set(Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === 'string') : []);
}

/** The top-level declared fields of an object schema, each under `prefix`. */
function fieldPaths(prefix: string, schema: unknown, inherited: { phiClass: string | null; deprecated: boolean }): SchemaVariablePath[] {
  const object = asObject(schema);
  const properties = asObject(object?.properties);
  if (properties === undefined) return [];
  const required = requiredNames(object);
  return Object.entries(properties).map(([field, raw]) => {
    const fieldSchema = asObject(raw);
    return {
      path: `${prefix}.${field}`,
      type: jsonType(fieldSchema),
      required: required.has(field),
      phiClass: inherited.phiClass,
      description: stringOrNull(fieldSchema?.description),
      deprecated: inherited.deprecated || fieldSchema?.deprecated === true,
    };
  });
}

function byPath(a: SchemaVariablePath, b: SchemaVariablePath): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function schemaVariablePaths(definition: unknown, root: string = 'context'): SchemaVariablePath[] {
  const document = asObject(definition);
  if (document === undefined) return [];

  if (Array.isArray(document.kinds)) {
    const kinds = document.kinds
      .map((kind) => asObject(kind))
      .filter((kind): kind is Record<string, unknown> => kind !== undefined && typeof kind.key === 'string' && kind.key.length > 0);

    const entries: SchemaVariablePath[] = [];
    const collapse = root === 'context' && kinds.length === 1 && kinds[0]?.key === SOLE_CONTEXT_KIND_KEY;
    for (const kind of kinds) {
      const key = kind.key as string;
      const phiClass = stringOrNull(kind.phiClass);
      const deprecated = asObject(kind.deprecated) !== undefined || kind.deprecated === true;
      const structured = kind.primitive === 'STRUCTURED';
      if (collapse) {
        if (structured) entries.push(...fieldPaths(root, kind.fields, { phiClass, deprecated }));
        continue;
      }
      entries.push({
        path: `${root}.${key}`,
        type: typeof kind.primitive === 'string' && kind.primitive.length > 0 ? kind.primitive : 'any',
        required: kind.required === true,
        phiClass,
        description: stringOrNull(kind.description),
        deprecated,
      });
      if (structured) entries.push(...fieldPaths(`${root}.${key}`, kind.fields, { phiClass, deprecated }));
    }
    return entries.sort(byPath);
  }

  const properties = asObject(document.properties);
  if (properties === undefined) return [];
  const required = requiredNames(document);
  const entries: SchemaVariablePath[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const schema = asObject(raw);
    const deprecated = schema?.deprecated === true;
    entries.push({
      path: `${root}.${key}`,
      type: jsonType(schema),
      required: required.has(key),
      phiClass: null,
      description: stringOrNull(schema?.description),
      deprecated,
    });
    entries.push(...fieldPaths(`${root}.${key}`, schema, { phiClass: null, deprecated }));
  }
  return entries.sort(byPath);
}
