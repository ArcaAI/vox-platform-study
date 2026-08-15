/**
 * JSON Schema (draft 2020-12) subset → TypeScript type expression.
 *
 * Mirrors the AUTHORABLE subset the server enforces at publish time
 * (`packages/applications/.../json-schema-subset.ts`,) and the
 * client-side VALUE evaluator ported into `@arcaai/vox`
 * (`contextPayloadValidation.ts`,): `type`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum`, `const`, `minLength`,
 * `maxLength`, `pattern`, `minimum`, `maximum`, `minItems`, `maxItems`,
 * `anyOf`, `allOf`, and discriminated `oneOf`. Constraint keywords
 * (`min/maxLength`, `pattern`, `minimum`, `maximum`, `min/maxItems`) have no
 * TypeScript representation and are intentionally not consulted here — they
 * remain runtime-only concerns (`contextPayloadValidation.ts` server-side
 * and client-side both enforce them; this module only shapes the type).
 *
 * This is a fresh, independent implementation, not an import of a shared
 * package — `@arcaai/json-schema-subset` does not exist at this baseline
 * (see `types.ts`'s header for why that also means this package hand-types
 * the bundle shape instead of importing it).
 *
 * ## Fail loudly, don't guess
 *
 * The server's authoring gate rejects `if`/`then`/`else` at publish, and
 * rejects `oneOf` without a sibling `discriminator.propertyName` — so a
 * legitimately published schema never carries either. But this function
 * reads untrusted wire JSON (a discovery bundle straight off the network),
 * so on either construct — or an unrecognized `type` value — it throws
 * `CodegenError` rather than silently ignoring the keyword and emitting a
 * type that lies about the payload shape. `cli.ts` surfaces that error to
 * the operator instead of writing a file.
 */

import { CodegenError } from './errors';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SUPPORTED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
type SupportedType = (typeof SUPPORTED_TYPES)[number];

function isSupportedType(value: unknown): value is SupportedType {
  return typeof value === 'string' && (SUPPORTED_TYPES as readonly string[]).includes(value);
}

export interface SchemaToTsOptions {
  /** Dotted path to the current node, for error messages only. */
  path?: string;
}

/** Render a JSON literal (string/number/boolean/null) as a TS literal type. */
function literalType(value: unknown, path: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  // An object/array `const` has no clean TS literal-type representation in
  // this subset. Render the shape of the value instead of failing — the
  // subset's authoring gate does not forbid a structured `const`, so this
  // stays a best-effort rendering rather than a thrown error.
  if (Array.isArray(value)) {
    return `readonly [${value.map((entry) => literalType(entry, path)).join(', ')}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.entries(value).map(([key, entry]) => `${propertyKeyLiteral(key)}: ${literalType(entry, path)};`);
    return members.length > 0 ? `{ ${members.join(' ')} }` : 'Record<string, never>';
  }
  return 'unknown';
}

/**
 * Render one authored JSON-Schema-subset node as a TypeScript type
 * expression, e.g. `{ foo: string }`, `('A' | 'B')`, `(string)[]`.
 *
 * Throws {@link CodegenError} for a construct that must never reach this
 * function from a legitimately published schema — see the module doc above.
 */
export function jsonSchemaSubsetToTs(schema: unknown, options: SchemaToTsOptions = {}): string {
  const path = options.path ?? '$';

  if (!isPlainObject(schema)) {
    throw new CodegenError(`${path}: expected a JSON Schema object node, got ${JSON.stringify(schema)}`);
  }

  if ('if' in schema || 'then' in schema || 'else' in schema) {
    throw new CodegenError(
      `${path}: 'if'/'then'/'else' is not in the authorable subset (the server rejects it at publish) — refusing to guess a type for it. ` +
        "This schema should never have reached codegen; re-fetch the tenant's schema or report this as a bug.",
    );
  }

  // A discriminated `oneOf` becomes a real TS union, one member per branch —
  // never merged property soup. An `oneOf` WITHOUT a sibling discriminator
  // is exactly the construct AC-8 forbids at publish; seeing one
  // here means either a bug upstream or a hand-built fixture, and either way
  // this function refuses to guess how to discriminate it.
  if (Array.isArray(schema.oneOf)) {
    if (
      !isPlainObject(schema.discriminator) ||
      typeof schema.discriminator.propertyName !== 'string' ||
      schema.discriminator.propertyName.length === 0
    ) {
      throw new CodegenError(
        `${path}: 'oneOf' without a sibling 'discriminator.propertyName' is not authorable (the server requires one) — refusing to emit merged property soup.`,
      );
    }
    const branches = schema.oneOf.map((branch, index) => jsonSchemaSubsetToTs(branch, { path: `${path}.oneOf[${index}]` }));
    return branches.length > 0 ? `(${branches.join(' | ')})` : 'never';
  }

  if ('const' in schema) {
    return literalType(schema.const, path);
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return 'never';
    return `(${schema.enum.map((entry) => literalType(entry, path)).join(' | ')})`;
  }

  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((branch, index) => jsonSchemaSubsetToTs(branch, { path: `${path}.allOf[${index}]` }));
    return parts.length > 0 ? `(${parts.join(' & ')})` : 'unknown';
  }

  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf.map((branch, index) => jsonSchemaSubsetToTs(branch, { path: `${path}.anyOf[${index}]` }));
    return parts.length > 0 ? `(${parts.join(' | ')})` : 'never';
  }

  if ('type' in schema) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    const rendered = declared.map((entry) => renderType(entry, schema, path));
    return rendered.length === 1 ? rendered[0] : `(${rendered.join(' | ')})`;
  }

  // No recognized keyword at all — an empty schema (`{}`, or an
  // annotation-only node such as `{ "description": "..." }`) accepts
  // anything, per JSON Schema semantics.
  return 'unknown';
}

function renderType(type: unknown, schema: Record<string, unknown>, path: string): string {
  if (!isSupportedType(type)) {
    throw new CodegenError(`${path}: unsupported JSON Schema 'type' value ${JSON.stringify(type)} (supported: ${SUPPORTED_TYPES.join(', ')})`);
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const itemsType = schema.items !== undefined ? jsonSchemaSubsetToTs(schema.items, { path: `${path}.items` }) : 'unknown';
      return `(${itemsType})[]`;
    }
    case 'object':
      return renderObjectType(schema, path);
  }
}

function renderObjectType(schema: Record<string, unknown>, path: string): string {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const propertyKeys = Object.keys(properties);

  const members = propertyKeys.map((key) => {
    const optional = required.has(key) ? '' : '?';
    const propertyType = jsonSchemaSubsetToTs(properties[key], { path: `${path}.properties.${key}` });
    return `${propertyKeyLiteral(key)}${optional}: ${propertyType};`;
  });

  if (isPlainObject(schema.additionalProperties)) {
    // A typed `additionalProperties` schema applies regardless of whether
    // named properties are also declared — TS is fine mixing specific
    // property types with a compatible index signature.
    const indexType = jsonSchemaSubsetToTs(schema.additionalProperties, { path: `${path}.additionalProperties` });
    members.push(`[key: string]: ${indexType};`);
    return `{ ${members.join(' ')} }`;
  }

  if (propertyKeys.length === 0) {
    // A fully open object (`{ "type": "object" }` with no declared shape at
    // all) — JSON Schema's default `additionalProperties: true` means
    // "any object", not "no properties" (which is what a bare `{}` TS type
    // would otherwise be read as). `additionalProperties: false` on an
    // otherwise-empty schema means the only conforming value has no keys.
    return schema.additionalProperties === false ? 'Record<string, never>' : 'Record<string, unknown>';
  }

  // Named properties only, no index signature — a deliberate approximation
  // when `additionalProperties` is `false` or left at its default `true`:
  // TS structural typing already tolerates extra properties on a plain
  // object type compared structurally, so this under-states strictness in
  // the `false` case rather than over-stating it in the (much more common)
  // default case. See the package README's "Known limitations" section.
  return `{ ${members.join(' ')} }`;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function propertyKeyLiteral(key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? key : JSON.stringify(key);
}
