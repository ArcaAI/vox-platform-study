/**
 * OpenAPI-3 schema → TypeScript type text.
 *
 * Scope is deliberately the subset `@nestjs/swagger` actually emits from
 * class-validator DTOs — `$ref`, `type`, `enum`, `items`, `properties` +
 * `required`, `additionalProperties`, `allOf`/`oneOf`/`anyOf`, `nullable`.
 * Anything outside that renders as `unknown` rather than a guess: the Phase B
 * fidelity spike measured a real minority of admin operations with no usable
 * schema (`openapi-fidelity.md` §B2), and the recorded decision was to emit
 * `unknown` at those specific call sites rather than block the generator or
 * invent a shape.
 *
 * The renderer records every `$ref` it walks through in a shared `used` set,
 * so `emit.ts` writes exactly the transitive closure of component schemas the
 * surface reaches — not all 490 of them.
 */

import { isSafePropertyName } from './naming';
import type { OpenApiDocument, OpenApiSchema } from './types';

const REF_PREFIX = '#/components/schemas/';

export class SchemaRenderer {
  /** Component schema names reached from the generated surface, in discovery order. */
  private readonly used = new Set<string>();

  /**
   * When set, {@link render} records every component name it writes into the
   * OUTPUT TEXT here. That is how each generated module derives its import
   * list.
   *
   * It exists because the obvious alternative — scanning the rendered text for
   * capitalized identifiers — is wrong in a way that compiles right up until
   * it does not: a `string` enum renders as a union of quoted LITERALS
   * (`'AiModel' | 'ApiKey' | …`), and those look exactly like type names to a
   * regex. `AuditLogResponse.resourceType` is such an enum, so the audit
   * module tried to import 60-odd nonexistent types.
   */
  private capture: Set<string> | null = null;

  constructor(private readonly document: OpenApiDocument) {}

  /** Run `fn`, returning the component names its rendering wrote into the output text. */
  capturing<T>(fn: () => T): { value: T; refs: string[] } {
    const previous = this.capture;
    const sink = new Set<string>();
    this.capture = sink;
    try {
      return { value: fn(), refs: [...sink].sort() };
    } finally {
      this.capture = previous;
    }
  }

  /** Component names the surface transitively reaches, sorted for stable emission. */
  usedSchemaNames(): string[] {
    return [...this.used].sort();
  }

  /** Resolve a `$ref` one hop. Returns `undefined` for a non-ref or an unresolvable ref. */
  private deref(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
    if (!schema?.$ref?.startsWith(REF_PREFIX)) return undefined;
    return this.document.components?.schemas?.[schema.$ref.slice(REF_PREFIX.length)];
  }

  /** The component NAME a schema refs, if it is a plain `$ref`. */
  refName(schema: OpenApiSchema | undefined): string | undefined {
    if (!schema?.$ref?.startsWith(REF_PREFIX)) return undefined;
    return schema.$ref.slice(REF_PREFIX.length);
  }

  /**
   * Follow `$ref`s (and single-member `allOf` wrappers) to the first schema
   * with real structure. Used to answer "is this response the house paginated
   * page?" without caring how many indirections the document put in the way.
   */
  resolve(schema: OpenApiSchema | undefined, depth = 0): OpenApiSchema | undefined {
    if (!schema || depth > 10) return schema;
    const target = this.deref(schema);
    if (target) return this.resolve(target, depth + 1);
    if (schema.allOf?.length === 1) return this.resolve(schema.allOf[0], depth + 1);
    return schema;
  }

  /**
   * Render `schema` as TypeScript. `inline: false` (the default) renders a
   * `$ref` as its component NAME and registers it; `inline: true` is used only
   * when emitting the component declarations themselves, one level down.
   */
  render(schema: OpenApiSchema | undefined, depth = 0): string {
    if (!schema || depth > 12) return 'unknown';

    const name = this.refName(schema);
    if (name) {
      this.registerSchema(name);
      this.capture?.add(name);
      return name;
    }

    if (schema.allOf?.length) {
      const parts = schema.allOf.map((s) => this.render(s, depth + 1)).filter((t) => t !== 'unknown');
      if (parts.length === 0) return 'unknown';
      return parts.length === 1 ? parts[0] : `(${parts.join(' & ')})`;
    }

    const union = schema.oneOf ?? schema.anyOf;
    if (union?.length) {
      const parts = [...new Set(union.map((s) => this.render(s, depth + 1)))];
      return parts.length === 1 ? parts[0] : `(${parts.join(' | ')})`;
    }

    return this.withNullable(schema, this.renderConcrete(schema, depth));
  }

  private withNullable(schema: OpenApiSchema, rendered: string): string {
    return schema.nullable === true && rendered !== 'unknown' ? `(${rendered} | null)` : rendered;
  }

  private renderConcrete(schema: OpenApiSchema, depth: number): string {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum.map((value) => (typeof value === 'string' ? `'${escapeSingleQuotes(value)}'` : JSON.stringify(value))).join(' | ');
    }

    switch (schema.type) {
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
        const item = this.render(schema.items, depth + 1);
        return item.includes(' ') && !item.startsWith('(') ? `Array<${item}>` : `${item}[]`;
      }
      case 'object':
      case undefined:
        return this.renderObject(schema, depth);
      default:
        return 'unknown';
    }
  }

  private renderObject(schema: OpenApiSchema, depth: number): string {
    const properties = schema.properties ?? {};
    const keys = Object.keys(properties).sort();
    const required = new Set(schema.required ?? []);

    if (keys.length === 0) {
      // `{}` / `{ type: 'object' }` with no properties is the document saying
      // "an object, shape unknown" — exactly the case the fidelity spike
      // counted as untyped. `additionalProperties` is the one form that still
      // carries information.
      if (schema.additionalProperties && schema.additionalProperties !== true) {
        return `Record<string, ${this.render(schema.additionalProperties, depth + 1)}>`;
      }
      if (schema.additionalProperties === true) return 'Record<string, unknown>';
      return schema.type === 'object' ? 'Record<string, unknown>' : 'unknown';
    }

    const members = keys.map((key) => {
      const rendered = this.render(properties[key], depth + 1);
      const optional = required.has(key) ? '' : '?';
      const quoted = isSafePropertyName(key) ? key : `'${escapeSingleQuotes(key)}'`;
      return `${quoted}${optional}: ${rendered};`;
    });

    return `{ ${members.join(' ')} }`;
  }

  /** Walk a component schema (and everything it refs) into {@link used}. */
  private registerSchema(name: string): void {
    if (this.used.has(name)) return;
    this.used.add(name);
    const schema = this.document.components?.schemas?.[name];
    if (schema) this.collectRefs(schema, 0);
  }

  private collectRefs(schema: OpenApiSchema | undefined, depth: number): void {
    if (!schema || depth > 20) return;
    const name = this.refName(schema);
    if (name) {
      this.registerSchema(name);
      return;
    }
    for (const child of [schema.items, ...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
      this.collectRefs(child, depth + 1);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      this.collectRefs(schema.additionalProperties, depth + 1);
    }
    for (const key of Object.keys(schema.properties ?? {}).sort()) {
      this.collectRefs(schema.properties?.[key], depth + 1);
    }
  }

  /**
   * Emit the declaration for one component schema. Objects become
   * `interface`s (so recursive DTOs work and the type name shows up in editor
   * hovers); everything else becomes a `type` alias.
   */
  declare(name: string): string {
    const schema = this.document.components?.schemas?.[name];
    if (!schema) return `export type ${name} = unknown;`;

    const isPlainObject = !schema.$ref && !schema.allOf && !schema.oneOf && !schema.anyOf && (schema.type === 'object' || schema.properties);
    if (isPlainObject && Object.keys(schema.properties ?? {}).length > 0) {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const members = Object.keys(properties)
        .sort()
        .map((key) => {
          const doc = renderPropertyDoc(properties[key]);
          const quoted = isSafePropertyName(key) ? key : `'${escapeSingleQuotes(key)}'`;
          return `${doc}  ${quoted}${required.has(key) ? '' : '?'}: ${this.render(properties[key], 1)};`;
        });
      return `export interface ${name} {\n${members.join('\n')}\n}`;
    }

    return `export type ${name} = ${this.render(schema, 1)};`;
  }
}

function renderPropertyDoc(schema: OpenApiSchema | undefined): string {
  const description = schema?.description?.trim();
  if (!description) return '';
  return `  /** ${sanitizeComment(description)} */\n`;
}

/** Flatten to one line and neutralize any `*&#47;` that would close the comment early. */
export function sanitizeComment(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '*\\/').trim();
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
