/**
 * @arcaai/vox - Client-side context payload validation (TASK-665)
 *
 * `useArcaSession().addContext()` calls `validateConsultationContextPayload`
 * BEFORE sending a `kindKey` + `payload` write, so a caller gets an immediate,
 * client-side error for a payload that clearly does not conform to the
 * tenant's declared `STRUCTURED` kind — without waiting on a round trip.
 *
 * ## Why this is hand-written, not `valibot`, and mirrors the server exactly
 *
 * `packages/applications/src/services/consultation-context-schema/json-schema-subset.ts`
 * (TASK-658) already answers this question on the server: the schema being
 * evaluated (`kind.fields`) is TENANT-AUTHORED at runtime, not a shape known
 * at SDK build time, so there is nothing for `valibot` (a static-schema
 * builder) to compile against. A general-purpose JSON Schema library would
 * also accept keywords the server's AUTHORING gate forbids (`if`/`then`/
 * `else`, undiscriminated `oneOf`), so validating with one here would let the
 * client silently accept payload shapes the server never would — worse than
 * not validating client-side at all. The evaluator below is therefore a
 * direct, dependency-free port of `jsonSchemaValueProblems`: same supported
 * keyword set, same semantics, so a payload this function accepts is a
 * payload the server accepts too (mirrors, not duplicates, the contract).
 *
 * This module validates a VALUE against an authored schema; it does not
 * re-validate the AUTHORED schema itself (`authorableJsonSchemaProblems`
 * server-side) — the schema only ever arrives here already published (and
 * therefore already passed that gate) via the discovery bundle.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

/**
 * Problems with a submitted VALUE against an authored (server-published)
 * JSON Schema subset document. Empty means the payload conforms.
 *
 * Supported keywords: `type`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const`, `minLength`, `maxLength`, `pattern`, `minimum`,
 * `maximum`, `minItems`, `maxItems`, `anyOf`, `allOf`, and discriminated
 * `oneOf` — identical to the server's supported set. Anything else in the
 * document is treated as an annotation and ignored, exactly as it is
 * server-side (the AUTHORING gate is what keeps unsupported constraints out
 * before a schema can ever be published).
 *
 * An empty schema (`{}`) accepts anything, per JSON Schema.
 */
export function contextPayloadProblems(schema: unknown, value: unknown, path = ''): string[] {
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
    return contextPayloadProblems(branch, value, path);
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
      value.forEach((entry, index) => problems.push(...contextPayloadProblems(schema.items, entry, `${path}/${index}`)));
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
        problems.push(...contextPayloadProblems(propertySchema, entry, `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}/${key}: property is not declared and additionalProperties is false`);
      } else if (isPlainObject(schema.additionalProperties)) {
        problems.push(...contextPayloadProblems(schema.additionalProperties, entry, `${path}/${key}`));
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((branch) => problems.push(...contextPayloadProblems(branch, value, path)));
  }

  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => contextPayloadProblems(branch, value, path).length === 0)) {
    problems.push(`${at}: matches none of the \`anyOf\` branches`);
  }

  // An UNdiscriminated `oneOf` cannot arrive here from a published schema
  // (the server's AUTHORING gate rejects it), but a caller could hand this
  // evaluator one directly (e.g. a hand-built kind in a test).
  if (Array.isArray(schema.oneOf) && !isPlainObject(schema.discriminator)) {
    const matches = schema.oneOf.filter((branch) => contextPayloadProblems(branch, value, path).length === 0).length;
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

// =============================================================================
// Orchestration — resolve a kind from the pinned bundle, then validate
// =============================================================================

import type { ConsultationSchemaBundle } from '../types/consultationSchema';
import { findConsultationContextKind } from '../types/consultationSchema';

export interface ContextPayloadValidationResult {
  valid: boolean;
  problems: string[];
}

/**
 * Validate a `{ kindKey, payload }` pair the caller is about to send in
 * `addContext()` against the SESSION-PINNED schema bundle.
 *
 * Deliberately permissive on anything it cannot resolve — this is a
 * fast-fail UX aid, never the source of truth:
 *  - No bundle, or the bundle's definition doesn't declare `kindKey` →
 *    `{ valid: true, problems: [] }`. The kind may be genuinely unknown to
 *    THIS build of the SDK (a tenant published it after the client shipped)
 *    — rejecting locally would break a client that is one release behind,
 *    which is exactly the forward-compatibility guarantee TASK-654 requires.
 *    The server is always the final authority and validates independently.
 *  - A resolved kind with no `fields` (non-`STRUCTURED`, or `payload`
 *    omitted) → nothing to validate against.
 */
export function validateConsultationContextPayload(
  bundle: ConsultationSchemaBundle | null | undefined,
  kindKey: string,
  payload: Record<string, unknown> | undefined,
): ContextPayloadValidationResult {
  const kind = findConsultationContextKind(bundle?.definition, kindKey);
  if (!kind || !isPlainObject(kind.fields) || payload === undefined) {
    return { valid: true, problems: [] };
  }
  const problems = contextPayloadProblems(kind.fields, payload);
  return { valid: problems.length === 0, problems };
}
