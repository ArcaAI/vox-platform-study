/**
 * TASK-971 lane B — derive the example request body for ONE published lineage from its own
 * declared input schema.
 *
 * ## Why a hand-rolled 80 lines and not a JSON-Schema library
 *
 * Nothing here validates. It reads the few keywords that describe a SHAPE — `properties`,
 * `required`, `type`, `default`, `enum` — and renders the smallest body a developer can paste.
 * An Ajv-class dependency in a Next.js client bundle to read five keywords would cost more than
 * it explains, and would still need this file's real decisions (which properties to show, what a
 * missing schema means) written on top of it.
 *
 * ## The two decisions worth stating
 *
 * **`null`, never `{}`.** An empty object is indistinguishable from "this endpoint takes an empty
 * body", which is a lie for every route the panel points at. Returning `null` lets the caller
 * fall back to the documented minimum (`{ text: '…' }` for an agent; an empty `input` envelope
 * for a workflow) and say so.
 *
 * **`required` narrows; its absence does not.** When the schema names required properties the
 * example is exactly those — the minimal accepted body. When it names none, showing nothing would
 * teach nothing, so every declared property appears. Both readings are deterministic: the same
 * schema always renders the same body, which is what lets the Node, Browser, HTTP and Postman
 * lanes print the SAME JSON and a developer trust that they are one contract.
 */

/** Depth ceiling — a `$ref`-cycled or self-referential schema must terminate, not hang a dialog. */
const MAX_DEPTH = 8;

/** The stand-in for a string the schema does not pin down. One glyph, so it never looks like data. */
const STRING_PLACEHOLDER = '…';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The type to render for. A union (`['null', 'integer']`, the usual "optional" spelling) renders
 * its first non-`null` member: `null` is what the caller would have omitted anyway.
 */
function resolveType(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const named = value.filter((entry): entry is string => typeof entry === 'string');
    return named.find((entry) => entry !== 'null') ?? named[0] ?? null;
  }
  return null;
}

function exampleValue(schema: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || !isRecord(schema)) return null;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (resolveType(schema.type)) {
    case 'string':
      return STRING_PLACEHOLDER;
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return isRecord(schema.items) ? [exampleValue(schema.items, depth + 1)] : [];
    case 'object':
      // A nested object with no declared shape IS accurately `{}` — unlike the top level, where
      // the caller needs to know the difference between "empty" and "unknown".
      return objectExample(schema, depth) ?? {};
    default:
      return null;
  }
}

function objectExample(schema: Record<string, unknown>, depth: number): Record<string, unknown> | null {
  if (depth > MAX_DEPTH) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;

  const declared = Object.keys(properties);
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  // A required key the schema never declared has no shape to render, so it is dropped rather than
  // guessed at; if that empties the selection the schema is unusable and the caller falls back.
  const chosen = required.length > 0 ? declared.filter((key) => required.includes(key)) : declared;
  if (chosen.length === 0) return null;

  const body: Record<string, unknown> = {};
  for (const key of chosen) body[key] = exampleValue(properties[key], depth + 1);
  return body;
}

/**
 * A minimal, deterministic example body for a JSON-Schema object, or `null` when the schema
 * describes no usable object shape (absent, not an object schema, or no declared properties).
 */
export function exampleBodyFromJsonSchema(schema: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isRecord(schema)) return null;
  return objectExample(schema, 0);
}
