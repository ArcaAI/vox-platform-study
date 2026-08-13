import { computeDefinitionChecksum } from './context-schema-definition';

/**
 * Classify a candidate definition against the currently
 * published one.
 *
 * ## What "requires a version bump" actually means here
 *
 * Every definition change writes an immutable version row — that is the audit
 * trail and is not negotiable. So the question a publish has to answer is not
 * "do we make a version?" but **"can a client that was built against the
 * previous version keep working?"**:
 *
 * | Classification | Meaning | Publish behaviour |
 * |---|---|---|
 * | `IDENTICAL` | same canonical bytes | no version row, pin unmoved, discovery ETag unchanged |
 * | `ADDITIVE`  | old clients and old payloads stay valid | publishes with no acknowledgement |
 * | `BREAKING`  | something old clients relied on is gone or narrowed | refused unless the admin passes `allowBreakingChange` |
 *
 * "A new optional field is additive; a rename is not" is exactly this split: a
 * rename is a REMOVAL plus an addition, and the removal is what breaks the
 * client.
 *
 * The classifier is deliberately CONSERVATIVE — anything it cannot prove safe
 * is BREAKING. Under-reporting a break silently invalidates in-flight
 * consultations; over-reporting one costs an admin a checkbox.
 */

export type DefinitionChangeClassification = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING';

export interface DefinitionChangeResult {
  classification: DefinitionChangeClassification;
  /** Human-readable reasons, empty unless the classification is BREAKING. */
  breakingChanges: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declarationsByKey(definition: unknown, collection: 'kinds' | 'outputs'): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!isPlainObject(definition)) return out;
  const entries = definition[collection];
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (isPlainObject(entry) && typeof entry.key === 'string') {
      out.set(entry.key, entry);
    }
  }
  return out;
}

export function classifyDefinitionChange(previous: unknown, next: unknown): DefinitionChangeResult {
  // A first publish has nothing to break.
  if (previous == null) {
    return { classification: 'ADDITIVE', breakingChanges: [] };
  }

  if (computeDefinitionChecksum(previous) === computeDefinitionChecksum(next)) {
    return { classification: 'IDENTICAL', breakingChanges: [] };
  }

  const breakingChanges: string[] = [];

  const previousKinds = declarationsByKey(previous, 'kinds');
  const nextKinds = declarationsByKey(next, 'kinds');

  for (const [key, before] of previousKinds) {
    const after = nextKinds.get(key);
    if (!after) {
      breakingChanges.push(`kind \`${key}\` was removed or renamed`);
      continue;
    }
    breakingChanges.push(...kindBreakingChanges(key, before, after));
  }

  const previousOutputs = declarationsByKey(previous, 'outputs');
  const nextOutputs = declarationsByKey(next, 'outputs');
  for (const [key, before] of previousOutputs) {
    const after = nextOutputs.get(key);
    if (!after) {
      breakingChanges.push(`output \`${key}\` was removed or renamed`);
      continue;
    }
    if (before.primitive !== after.primitive) {
      breakingChanges.push(`output \`${key}\`: primitive changed from ${String(before.primitive)} to ${String(after.primitive)}`);
    }
    breakingChanges.push(...fieldsBreakingChanges(`output \`${key}\``, before.fields, after.fields));
  }

  return breakingChanges.length > 0 ? { classification: 'BREAKING', breakingChanges } : { classification: 'ADDITIVE', breakingChanges: [] };
}

function kindBreakingChanges(key: string, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changes: string[] = [];
  const label = `kind \`${key}\``;

  // These three decide how the ENGINE handles the item (which substrate, which
  // encryption posture, how many are allowed). A change is never compatible.
  for (const attribute of ['primitive', 'phiClass', 'cardinality'] as const) {
    if (before[attribute] !== after[attribute]) {
      changes.push(`${label}: ${attribute} changed from ${String(before[attribute])} to ${String(after[attribute])}`);
    }
  }

  // Making a previously optional kind mandatory invalidates every client that
  // does not send it. The reverse (true -> false) is a relaxation.
  if (before.required !== true && after.required === true) {
    changes.push(`${label}: became required`);
  }

  changes.push(...fieldsBreakingChanges(label, before.fields, after.fields));
  return changes;
}

function fieldsBreakingChanges(label: string, before: unknown, after: unknown): string[] {
  const changes: string[] = [];

  // Dropping the field schema entirely means every previously validated
  // constraint is gone; adding one where there was none is a narrowing.
  if (isPlainObject(before) && !isPlainObject(after)) {
    changes.push(`${label}: field schema was removed`);
    return changes;
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return changes;
  }

  const beforeProperties = isPlainObject(before.properties) ? before.properties : {};
  const afterProperties = isPlainObject(after.properties) ? after.properties : {};

  for (const [property, beforeSchema] of Object.entries(beforeProperties)) {
    const afterSchema = afterProperties[property];
    if (afterSchema === undefined) {
      changes.push(`${label}: property \`${property}\` was removed or renamed`);
      continue;
    }
    const beforeType = isPlainObject(beforeSchema) ? beforeSchema.type : undefined;
    const afterType = isPlainObject(afterSchema) ? afterSchema.type : undefined;
    if (JSON.stringify(beforeType ?? null) !== JSON.stringify(afterType ?? null)) {
      changes.push(`${label}: property \`${property}\` changed type from ${String(beforeType)} to ${String(afterType)}`);
    }
    changes.push(...fieldsBreakingChanges(`${label} property \`${property}\``, beforeSchema, afterSchema));
  }

  const beforeRequired = new Set(Array.isArray(before.required) ? before.required : []);
  const afterRequired = Array.isArray(after.required) ? after.required : [];
  for (const property of afterRequired) {
    if (!beforeRequired.has(property)) {
      changes.push(`${label}: property \`${String(property)}\` became required`);
    }
  }

  // Closing an open object rejects payloads that were previously accepted.
  if (before.additionalProperties !== false && after.additionalProperties === false) {
    changes.push(`${label}: additionalProperties was closed`);
  }

  return changes;
}
