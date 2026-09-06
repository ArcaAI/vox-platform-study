/**
 * TASK-890 black-box J4-F5 — the concrete `{{trigger.…}}` paths this workflow offers.
 *
 * A trigger payload is keyed by the context schema's KIND KEY, so the reference an admin must
 * write is `{{trigger.<kindKey>.<field>}}`. Offering only the `trigger.` root left that middle
 * segment to guesswork, and a wrong guess is silent — the interpolation simply resolves to
 * nothing.
 *
 * A DELIBERATE client mirror of `payloadSchemaFromDefinition`
 * (`@arcaai/applications/services/consultation-context-schema/context-schema-definition.ts`),
 * which is a SERVER package the console cannot import: one entry per declared kind, and a
 * `STRUCTURED` kind additionally contributes its own declared fields. Outputs are ignored — an
 * output is produced BY the run, never supplied to it. Keep the two in step: if the derivation
 * there changes, this list stops matching what the run actually validates.
 *
 * Total: anything unreadable yields `[]` — "we don't know this workflow's paths" is a state the
 * field renders a hint for, never an invented path.
 */

const TRIGGER_ROOT = 'trigger';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `<root>.<key>` plus one entry per declared field of that key's own object schema. */
function pathsForProperty(key: string, schema: unknown): string[] {
  const properties = asObject(asObject(schema)?.properties);
  return [`${TRIGGER_ROOT}.${key}`, ...(properties ? Object.keys(properties).map((field) => `${TRIGGER_ROOT}.${key}.${field}`) : [])];
}

export interface TriggerContextBinding {
  /** A `ConsultationContextSchemaVersion.definition` (the reference case). */
  definition?: unknown;
  /** An inline JSON Schema authored on the trigger — already in payload shape. */
  inline?: unknown;
}

export function triggerVariablePaths({ definition, inline }: TriggerContextBinding): string[] {
  const kinds = asObject(definition)?.kinds;
  if (Array.isArray(kinds)) {
    return kinds.flatMap((kind) => {
      const declared = asObject(kind);
      const key = declared?.key;
      if (typeof key !== 'string' || key.length === 0) return [];
      return declared?.primitive === 'STRUCTURED' ? pathsForProperty(key, declared.fields) : [`${TRIGGER_ROOT}.${key}`];
    });
  }

  const properties = asObject(asObject(inline)?.properties);
  if (properties) return Object.entries(properties).flatMap(([key, schema]) => pathsForProperty(key, schema));

  return [];
}
