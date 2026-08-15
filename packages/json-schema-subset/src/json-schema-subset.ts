/**
 * The CONSTRAINED JSON Schema (draft 2020-12) subset a tenant may author
 * inside a `ConsultationContextSchema` definition, plus the evaluator that
 * validates a submitted payload against it.
 *
 * ## One implementation, three consumers
 *
 * This module is the SINGLE implementation of the rule. It originated in
 * `@arcaai/applications` and was ported twice — into the browser
 * SDK and the admin console — because neither can
 * depend on a server-only NestJS package. Three copies of one clinical
 * validation rule drift, and the drift is silent in both directions: a
 * payload the console accepts but the server rejects, or one both accept for
 * different reasons. Hence this package: zero runtime dependencies, so the
 * browser SDK can bundle it without weight, and one definition all three
 * consume.
 *
 * The server remains the AUTHORITATIVE enforcement point — the SDK and
 * console call these functions as a fast-fail UX aid, never as the gate.
 * They can now only ever agree with the server, because it is the same code.
 *
 * ## Why a subset, and why hand-written
 *
 * The definition is authored by a TENANT and is consumed by three very
 * different things: this evaluator, the admin-console editor and
 * the SDK codegen CLI. A keyword that any one of them cannot
 * express faithfully is a keyword that must not be authorable at all —
 * otherwise the generated client and the server disagree about what a valid
 * payload is, which in a PHI system is a correctness bug wearing a
 * convenience hat.
 *
 * Two exclusions are therefore hard:
 *
 * - **`if` / `then` / `else`** — conditional subschemas have no clean
 * TypeScript equivalent; codegen would have to widen everything to
 * optional and drop the constraint entirely.
 * - **`oneOf` without an explicit `discriminator`** — without a
 * discriminating property a generator cannot emit a tagged union and
 * instead emits merged property soup, in which every branch's fields look
 * optional. The discriminator is also what lets THIS evaluator report the
 * error from the branch the author meant, rather than N confusing branch
 * errors.
 *
 * Two further limits exist for safety rather than expressiveness: a bounded
 * nesting depth and a bounded node count. An authored document is untrusted
 * input that is walked on every payload write.
 *
 * No JSON Schema library is a dependency of this package (no ajv, no zod), and
 * that is deliberate: a general-purpose validator would happily accept the
 * keywords above, so the subset would be documentation rather than
 * enforcement. Keep this package dependency-free — it is bundled into
 * `@arcaai/vox`, whose bundle size is actively policed.
 */

/** Maximum nesting depth of an authored schema. */
export const MAX_SCHEMA_DEPTH = 12;

/** Maximum number of schema nodes in one authored schema. */
export const MAX_SCHEMA_NODES = 512;

/** Keywords that are never authorable — see the module docstring. */
const FORBIDDEN_KEYWORDS = ['if', 'then', 'else'] as const;

const JSON_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
type JsonSchemaType = (typeof JSON_SCHEMA_TYPES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural problems with an AUTHORED schema, as human-readable strings each
 * prefixed with the JSON-pointer-ish path at which the problem sits. An empty
 * array means the schema is authorable.
 *
 * Returns problems rather than throwing so the caller can surface every
 * problem in one 400 — an admin editing a large definition should not have to
 * discover its faults one round-trip at a time.
 */
export function authorableJsonSchemaProblems(schema: unknown, path = ''): string[] {
  const problems: string[] = [];
  const budget = { nodes: 0 };
  walkAuthorable(schema, path, 0, problems, budget);
  return problems;
}

function walkAuthorable(schema: unknown, path: string, depth: number, problems: string[], budget: { nodes: number }): void {
  if (!isPlainObject(schema)) {
    problems.push(`${path || '/'}: schema must be a JSON object`);
    return;
  }

  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NODES) {
    if (budget.nodes === MAX_SCHEMA_NODES + 1) {
      problems.push(`${path || '/'}: schema exceeds the maximum of ${MAX_SCHEMA_NODES} nodes`);
    }
    return;
  }

  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`${path || '/'}: schema exceeds the maximum nesting depth of ${MAX_SCHEMA_DEPTH}`);
    return;
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (keyword in schema) {
      problems.push(`${path || '/'}: \`if\`/\`then\`/\`else\` is not authorable (no faithful TypeScript equivalent for generated clients)`);
      break;
    }
  }

  if ('oneOf' in schema) {
    const discriminator = schema.discriminator;
    if (!isPlainObject(discriminator)) {
      problems.push(`${path || '/'}: \`oneOf\` requires a sibling \`discriminator: { propertyName }\``);
    } else if (typeof discriminator.propertyName !== 'string' || discriminator.propertyName.length === 0) {
      problems.push(`${path || '/'}: \`discriminator.propertyName\` must be a non-empty string`);
    }
  }

  if ('type' in schema) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of declared) {
      if (typeof t !== 'string' || !(JSON_SCHEMA_TYPES as readonly string[]).includes(t)) {
        problems.push(`${path || '/'}/type: unsupported type \`${String(t)}\``);
      }
    }
  }

  if (isPlainObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      walkAuthorable(sub, `${path}/properties/${key}`, depth + 1, problems, budget);
    }
  }

  if (schema.items !== undefined) {
    walkAuthorable(schema.items, `${path}/items`, depth + 1, problems, budget);
  }

  if (isPlainObject(schema.additionalProperties)) {
    walkAuthorable(schema.additionalProperties, `${path}/additionalProperties`, depth + 1, problems, budget);
  }

  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => walkAuthorable(branch, `${path}/${combinator}/${index}`, depth + 1, problems, budget));
    }
  }
}

/**
 * Problems with a submitted VALUE against an authored schema. Empty means the
 * payload conforms.
 *
 * Supported keywords: `type`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const`, `minLength`, `maxLength`, `pattern`, `minimum`,
 * `maximum`, `minItems`, `maxItems`, `anyOf`, `allOf`, and discriminated
 * `oneOf`. Anything else in the document is an annotation and is ignored —
 * the AUTHORING gate above is what keeps unsupported *constraints* out, so
 * "ignored here" can only ever mean "not a constraint".
 *
 * An empty schema (`{}`) accepts anything, per JSON Schema.
 */
export function jsonSchemaValueProblems(schema: unknown, value: unknown, path = ''): string[] {
  if (!isPlainObject(schema)) {
    return [`${path || '/'}: schema must be a JSON object`];
  }

  const problems: string[] = [];
  const at = path || '/';

  // A discriminated `oneOf` routes to exactly ONE branch, so the caller gets
  // the error the author meant instead of one failure per branch.
  if (Array.isArray(schema.oneOf) && isPlainObject(schema.discriminator)) {
    const propertyName = String(schema.discriminator.propertyName);
    const tag = isPlainObject(value) ? value[propertyName] : undefined;
    const branch = schema.oneOf.find((candidate) => branchMatchesTag(candidate, propertyName, tag));
    if (!branch) {
      return [`${at}/${propertyName}: no \`oneOf\` branch matches discriminator value ${JSON.stringify(tag)}`];
    }
    return jsonSchemaValueProblems(branch, value, path);
  }

  if ('const' in schema && !deepEqual(schema.const, value)) {
    problems.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    problems.push(`${at}: must be one of the declared enum values`);
  }

  if ('type' in schema) {
    const declared = (Array.isArray(schema.type) ? schema.type : [schema.type]) as JsonSchemaType[];
    if (!declared.some((t) => matchesType(t, value))) {
      problems.push(`${at}: expected ${declared.join(' | ')}`);
      // A type mismatch makes every keyword below meaningless — reporting
      // "maxLength" on a number is noise, not help.
      return problems;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      problems.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      problems.push(`${at}: longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${at}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      problems.push(`${at}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      problems.push(`${at}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      problems.push(`${at}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      problems.push(`${at}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => problems.push(...jsonSchemaValueProblems(schema.items, entry, `${path}/${index}`)));
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) {
          problems.push(`${path}/${key}: required property is missing`);
        }
      }
    }

    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        problems.push(...jsonSchemaValueProblems(propertySchema, entry, `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}/${key}: property is not declared and additionalProperties is false`);
      } else if (isPlainObject(schema.additionalProperties)) {
        problems.push(...jsonSchemaValueProblems(schema.additionalProperties, entry, `${path}/${key}`));
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((branch) => problems.push(...jsonSchemaValueProblems(branch, value, path)));
  }

  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => jsonSchemaValueProblems(branch, value, path).length === 0)) {
    problems.push(`${at}: matches none of the \`anyOf\` branches`);
  }

  // An UNdiscriminated `oneOf` cannot appear in an authored schema (the gate
  // above rejects it), but a caller could hand this evaluator one directly.
  if (Array.isArray(schema.oneOf) && !isPlainObject(schema.discriminator)) {
    const matches = schema.oneOf.filter((branch) => jsonSchemaValueProblems(branch, value, path).length === 0).length;
    if (matches !== 1) {
      problems.push(`${at}: must match exactly one \`oneOf\` branch (matched ${matches})`);
    }
  }

  return problems;
}

function branchMatchesTag(branch: unknown, propertyName: string, tag: unknown): boolean {
  if (!isPlainObject(branch) || !isPlainObject(branch.properties)) return false;
  const tagSchema = branch.properties[propertyName];
  if (!isPlainObject(tagSchema)) return false;
  if ('const' in tagSchema) return deepEqual(tagSchema.const, tag);
  if (Array.isArray(tagSchema.enum)) return tagSchema.enum.some((candidate) => deepEqual(candidate, tag));
  return false;
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
  }
  return false;
}
