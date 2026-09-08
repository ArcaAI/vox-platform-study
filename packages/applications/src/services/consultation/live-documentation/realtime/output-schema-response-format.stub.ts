/**
 * TEMPORARY LOCAL STUB — TASK-893 lane R, to be swapped at integration.
 *
 * INTERFACES §5 (contract N4): lane N authors `outputSchemaResponseFormat` in
 * `packages/workflow-contract/src/agent-schemas.ts` and lane R exports it from that package's
 * barrel (amendment A-4). The symbol was not yet on lane R's base, so this file carries the
 * EXACT contract signature and rule so the realtime `core.agent` handler can apply it today.
 * The orchestrator replaces the import in `realtime-node-registry.ts` with
 * `import { outputSchemaResponseFormat } from '@arcaai/workflow-contract'` and deletes this file.
 */

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown>; readonly strict: true };
}

function isObjectSchemaWithProperties(schema: unknown): schema is Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object') return false;
  const properties = record.properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties) && Object.keys(properties).length >= 1;
}

/** `undefined` when the declared output is the task default or not an object schema with ≥1 property,
 *  or when `parameters.responseFormat` is set (the explicit hyper-parameter always wins). */
export function outputSchemaResponseFormat(
  slug: string,
  outputSchema: unknown,
  parameters: Record<string, unknown> | null | undefined,
): JsonSchemaResponseFormat | undefined {
  if (parameters !== null && parameters !== undefined && parameters.responseFormat !== undefined) return undefined;
  if (!isObjectSchemaWithProperties(outputSchema)) return undefined;
  // The task default (`AGENT_IO_DEFAULTS.TEXT_GENERATION.output`) is `{ text }` — a declared
  // output that IS the default enforces nothing an unconstrained call would not already produce.
  const keys = Object.keys(outputSchema.properties as Record<string, unknown>);
  if (keys.length === 1 && keys[0] === 'text') return undefined;
  return { type: 'json_schema', json_schema: { name: `${slug.replace(/[^a-z0-9_]/gi, '_')}_output`, schema: outputSchema, strict: true } };
}
