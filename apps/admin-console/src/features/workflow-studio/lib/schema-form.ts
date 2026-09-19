/**
 * The schema-to-field-descriptor compiler — strategy's
 * "Contract tests: one schema, three consumers (registry ↔ inspector forms ↔ compiled
 * config)", consumer #2. Pure and framework-free (no React import) so it is unit-testable in
 * isolation and reusable by node-isolation panel.
 *
 * Input: a registry node-type config JSON Schema (the `@arcaai/json-schema-subset` authorable
 * subset — `contracts/registry.contract.md`). Output: an ordered `FieldDescriptor`.
 *
 * Validation is delegated, never re-implemented ( pitfall 1 /: this module
 * never decides whether a VALUE is valid — that is `jsonSchemaValueProblems` alone, called by
 * the inspector , never re-derived here. This module only decides how to RENDER a
 * schema; `authorableJsonSchemaProblems` is used only to detect a subtree this rendering
 * cannot represent, so it can degrade to the raw JSON editor for that subtree.
 */
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';

export interface FieldDescriptorBase {
  path: string;
  label: string;
  required: boolean;
  description?: string;
  /**
   * TASK-893 §3.5 — the field's one-line, plain-language summary, carried alongside (never
   * instead of) `description`. The inspector renders THIS inline and puts `description` behind a
   * `?` popover: the schema descriptions are normative contract text — the `enabled` field's runs
   * to ~500 characters of MUST/never phrasing — which is exactly right for the API docs and
   * unreadable in a form. Absent for any field whose schema has not been annotated yet, where the
   * inspector falls back to a one-line truncation of `description`.
   */
  summary?: string;
}

export interface StringFieldDescriptor extends FieldDescriptorBase {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  default?: string;
}

export interface EnumFieldDescriptor extends FieldDescriptorBase {
  kind: 'enum';
  options: Array<{ value: string; label: string }>;
  default?: string;
}

export interface NumberFieldDescriptor extends FieldDescriptorBase {
  kind: 'number';
  integer: boolean;
  min?: number;
  max?: number;
  step?: number;
  default?: number;
}

export interface BooleanFieldDescriptor extends FieldDescriptorBase {
  kind: 'boolean';
  default?: boolean;
}

export interface TagsFieldDescriptor extends FieldDescriptorBase {
  kind: 'tags';
  minItems?: number;
  maxItems?: number;
}

export interface GroupFieldDescriptor extends FieldDescriptorBase {
  kind: 'group';
  fields: FieldDescriptor[];
}

export interface DiscriminatedFieldDescriptor extends FieldDescriptorBase {
  kind: 'discriminated';
  discriminatorProperty: string;
  branches: Array<{ value: string; fields: FieldDescriptor[] }>;
}

export interface RawJsonFieldDescriptor extends FieldDescriptorBase {
  kind: 'raw-json';
  /** Why this subtree fell back to the raw editor — surfaced to the author, not swallowed. */
  reason: string;
}

export type FieldDescriptor =
  | StringFieldDescriptor
  | EnumFieldDescriptor
  | NumberFieldDescriptor
  | BooleanFieldDescriptor
  | TagsFieldDescriptor
  | GroupFieldDescriptor
  | DiscriminatedFieldDescriptor
  | RawJsonFieldDescriptor;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-word overrides for `humanizeKey`'s capitalize-first-letter rule, for the rare key that
 * IS an acronym rather than a plain word (`dna` -> `Dna` is wrong; it must read `DNA`). Checked
 * case-insensitively against each split word. Keep this to acronyms actually authored as a
 * schema/registry key today (F-10) — it is not a general style dictionary, and
 * `promptTemplateId` -> `Prompt Template Id` (no `ID`) stays the documented, pinned behavior.
 */
const ACRONYM_WORDS: Readonly<Record<string, string>> = Object.freeze({
  dna: 'DNA',
});

/** `promptTemplateId` -> `Prompt Template Id`. Used when the schema carries no `title`, and
 *  re-exported for the palette rail to derive a display label from a bare registry
 *  `type` string — the delivered registry has no `label` field (registry.contract.md). */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/);
  return words
    .map((word) => (word.length === 0 ? word : (ACRONYM_WORDS[word.toLowerCase()] ?? word[0].toUpperCase() + word.slice(1))))
    .join(' ');
}

function labelFor(key: string, schema: Record<string, unknown>): string {
  return typeof schema.title === 'string' && schema.title.length > 0 ? schema.title : humanizeKey(key);
}

function isBoundsProblem(problem: string): boolean {
  return problem.includes('exceeds the maximum');
}

const TOO_COMPLEX_REASON = 'schema too complex — edit as JSON';

/**
 * The single entry point. Never throws — an unrepresentable schema (or subtree) degrades to a
 * `raw-json` descriptor rather than crashing or silently dropping the field (README Task 7
 * approach, points 3–4).
 */
export function toFieldDescriptors(schema: unknown): FieldDescriptor[] {
  const rootProblems = authorableJsonSchemaProblems(schema);
  if (rootProblems.some(isBoundsProblem)) {
    return [{ kind: 'raw-json', path: '', label: 'Configuration', required: false, reason: TOO_COMPLEX_REASON }];
  }

  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
    return [];
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);

  return Object.entries(schema.properties).map(([key, propSchema]) => compileField(key, propSchema, required.has(key), key));
}

function compileField(key: string, rawSchema: unknown, required: boolean, path: string): FieldDescriptor {
  // A subtree that is itself within bounds but uses a forbidden construct (if/then/else, an
  // undiscriminated oneOf) degrades to raw-json for THIS field only — siblings still compile.
  const problems = authorableJsonSchemaProblems(rawSchema, path).filter((problem) => !isBoundsProblem(problem));
  if (problems.length > 0) {
    return {
      kind: 'raw-json',
      path,
      label: isPlainObject(rawSchema) ? labelFor(key, rawSchema) : humanizeKey(key),
      required,
      reason: problems.join('; '),
    };
  }

  if (!isPlainObject(rawSchema)) {
    return { kind: 'raw-json', path, label: humanizeKey(key), required, reason: 'schema is not a JSON object' };
  }

  const label = labelFor(key, rawSchema);
  const description = typeof rawSchema.description === 'string' ? rawSchema.description : undefined;
  const summary = typeof rawSchema.summary === 'string' ? rawSchema.summary : undefined;
  const base: FieldDescriptorBase = { path, label, required, description, summary };

  if (Array.isArray(rawSchema.enum) && rawSchema.enum.every((v): v is string => typeof v === 'string')) {
    return {
      ...base,
      kind: 'enum',
      options: rawSchema.enum.map((value) => ({ value, label: value })),
      default: typeof rawSchema.default === 'string' ? rawSchema.default : undefined,
    };
  }

  if ('oneOf' in rawSchema && isPlainObject(rawSchema.discriminator) && typeof rawSchema.discriminator.propertyName === 'string') {
    const discriminatorProperty = rawSchema.discriminator.propertyName;
    const branches = (rawSchema.oneOf as unknown[]).map((branch) => compileDiscriminatedBranch(branch, discriminatorProperty, path));
    return { ...base, kind: 'discriminated', discriminatorProperty, branches };
  }

  const type = rawSchema.type;

  if (type === 'string') {
    return {
      ...base,
      kind: 'string',
      minLength: typeof rawSchema.minLength === 'number' ? rawSchema.minLength : undefined,
      maxLength: typeof rawSchema.maxLength === 'number' ? rawSchema.maxLength : undefined,
      pattern: typeof rawSchema.pattern === 'string' ? rawSchema.pattern : undefined,
      format: typeof rawSchema.format === 'string' ? rawSchema.format : undefined,
      default: typeof rawSchema.default === 'string' ? rawSchema.default : undefined,
    };
  }

  if (type === 'number' || type === 'integer') {
    return {
      ...base,
      kind: 'number',
      integer: type === 'integer',
      min: typeof rawSchema.minimum === 'number' ? rawSchema.minimum : undefined,
      max: typeof rawSchema.maximum === 'number' ? rawSchema.maximum : undefined,
      step: type === 'integer' ? 1 : undefined,
      default: typeof rawSchema.default === 'number' ? rawSchema.default : undefined,
    };
  }

  if (type === 'boolean') {
    return { ...base, kind: 'boolean', default: typeof rawSchema.default === 'boolean' ? rawSchema.default : undefined };
  }

  if (type === 'array' && isPlainObject(rawSchema.items) && rawSchema.items.type === 'string') {
    return {
      ...base,
      kind: 'tags',
      minItems: typeof rawSchema.minItems === 'number' ? rawSchema.minItems : undefined,
      maxItems: typeof rawSchema.maxItems === 'number' ? rawSchema.maxItems : undefined,
    };
  }

  if (type === 'object' && isPlainObject(rawSchema.properties)) {
    const nestedRequired = new Set(Array.isArray(rawSchema.required) ? rawSchema.required.filter((r): r is string => typeof r === 'string') : []);
    const fields = Object.entries(rawSchema.properties).map(([nestedKey, nestedSchema]) =>
      compileField(nestedKey, nestedSchema, nestedRequired.has(nestedKey), `${path}.${nestedKey}`),
    );
    return { ...base, kind: 'group', fields };
  }

  // Anything else (no recognized `type`, an array of primitive types, a bare `{}`, …) is not a
  // silent drop — it becomes an explicit raw-json descriptor at this path.
  return { ...base, kind: 'raw-json', reason: `unsupported construct at ${path || '/'} — edit as JSON` };
}

function compileDiscriminatedBranch(branch: unknown, discriminatorProperty: string, parentPath: string): { value: string; fields: FieldDescriptor[] } {
  if (!isPlainObject(branch) || !isPlainObject(branch.properties)) {
    return { value: '(unknown)', fields: [] };
  }
  const discriminatorSchema = branch.properties[discriminatorProperty];
  const value = isPlainObject(discriminatorSchema) && Array.isArray(discriminatorSchema.enum) && typeof discriminatorSchema.enum[0] === 'string' ? discriminatorSchema.enum[0] : '(unknown)';
  const required = new Set(Array.isArray(branch.required) ? branch.required.filter((r): r is string => typeof r === 'string') : []);
  const fields = Object.entries(branch.properties)
    .filter(([key]) => key !== discriminatorProperty)
    .map(([key, propSchema]) => compileField(key, propSchema, required.has(key), `${parentPath}.${key}`));
  return { value, fields };
}

/** Bounds re-exported so a consumer can explain the raw-json fallback without importing `@arcaai/json-schema-subset` directly for just these two constants. */
export { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES };
