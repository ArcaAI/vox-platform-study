/**
 * Who depends on a context schema, and would a publish break them.
 *
 * ## Why this is a leaf module of pure functions
 *
 * Three surfaces have to agree on the answer, and they run at different moments:
 *
 * | Surface | When |
 * |---|---|
 * | `GET admin/consultation-context-schemas/:id/usages` | an admin opens the schema |
 * | the `impact` embedded in the `publish` / `pin` response | the moment the pin moves |
 * | the acknowledgement gate that refuses a publish with `SCHEMA_IMPACT_UNACKNOWLEDGED` | the same moment |
 *
 * If the console computed one verdict and the gate another, an admin would tick a box that
 * acknowledged something other than what is about to happen. So the rule lives here, once,
 * with no I/O and no Nest — the service does the reads and hands the bytes in.
 *
 * ## The rule, and why it is only about KIND KEYS
 *
 * A consumer freezes the DERIVED payload schema (`payloadSchemaFromDefinition`) of the version
 * it was bound to, and the interpreter validates a run payload against those frozen bytes —
 * which carry `additionalProperties: false`. So the ONE thing a later version can do that the
 * frozen bytes will reject outright is introduce a kind key they do not declare: every other
 * evolution the classifier already calls BREAKING (a removed kind, a narrowed field) makes the
 * NEW payload smaller or stricter, and stricter payloads still satisfy older frozen bytes.
 *
 * A FOLLOW-LATEST consumer re-resolves the tenant's pin at dispatch, so nothing a publish does
 * can surprise it — it accepts by construction, and its frozen bytes are not even read.
 *
 * `unknown` is reserved for "the compiled bytes could not be read". It is deliberately NOT
 * folded into `accepts`: an unreadable consumer is a thing an admin should see, not a silent
 * pass.
 */

export type ContextSchemaBinding = 'latest' | 'pinned';
export type ContextSchemaVerdict = 'accepts' | 'refuses' | 'unknown';

export interface ContextSchemaUsageVerdict {
  verdict: ContextSchemaVerdict;
  problems: string[];
}

export interface ContextSchemaBoundUsage extends ContextSchemaUsageVerdict {
  binding: ContextSchemaBinding;
  boundVersion: number | null;
}

export interface UsageVerdictInput {
  binding: ContextSchemaBinding;
  /** The version the consumer's bytes were frozen from — only ever rendered, never compared. */
  boundVersion: number | null;
  /** `payloadSchemaFromDefinition` of the version being published or pinned. */
  targetPayloadSchema: Record<string, unknown>;
  /** The consumer's FROZEN payload schema, or `null` when its compiled bytes are unreadable. */
  frozenPayloadSchema: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The kind keys a derived payload schema admits, in declaration order. */
function kindKeysOf(payloadSchema: unknown): string[] {
  const properties = isPlainObject(payloadSchema) ? payloadSchema.properties : undefined;
  return isPlainObject(properties) ? Object.keys(properties) : [];
}

/** How a version number renders inside a problem string — `v3`, or `v?` when it is unknown. */
function versionLabel(boundVersion: number | null): string {
  return boundVersion == null ? 'v?' : `v${boundVersion}`;
}

/**
 * The rule itself. Pure, total, and the ONLY definition of "refuses" in the platform.
 */
export function usageVerdict(input: UsageVerdictInput): ContextSchemaUsageVerdict {
  if (input.binding === 'latest') {
    return { verdict: 'accepts', problems: [] };
  }

  if (!isPlainObject(input.frozenPayloadSchema)) {
    return {
      verdict: 'unknown',
      problems: ['the compiled configuration this consumer was published with could not be read'],
    };
  }

  const declared = new Set(kindKeysOf(input.frozenPayloadSchema));
  const problems = kindKeysOf(input.targetPayloadSchema)
    .filter((kindKey) => !declared.has(kindKey))
    .map((kindKey) => `/${kindKey}: not declared in the bound version ${versionLabel(input.boundVersion)}`);

  return problems.length > 0 ? { verdict: 'refuses', problems } : { verdict: 'accepts', problems: [] };
}

/**
 * The frozen trigger payload schema of a compiled WORKFLOW config.
 *
 * Structurally identical to `compiledTriggerContextSchema` in `@arcaai/workflow-contract`, and
 * deliberately NOT an import of it: this package must be able to answer for a compiled artifact
 * without taking a value dependency on the contract package from the context-schema leaf. Both
 * read the same documented path (`stages[].nodes[] where type = core.trigger` →
 * `config.contextSchema.resolved`), and the compiled-config JSON Schema is what keeps them
 * honest about it.
 */
export function frozenTriggerPayloadSchema(compiledConfig: unknown): Record<string, unknown> | null {
  const stages = isPlainObject(compiledConfig) ? compiledConfig.stages : undefined;
  if (!Array.isArray(stages)) return null;
  for (const stage of stages) {
    const nodes = isPlainObject(stage) ? stage.nodes : undefined;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!isPlainObject(node) || node.type !== 'core.trigger') continue;
      const contextSchema = isPlainObject(node.config) ? node.config.contextSchema : undefined;
      const resolved = isPlainObject(contextSchema) ? contextSchema.resolved : undefined;
      if (isPlainObject(resolved)) return resolved;
    }
  }
  return null;
}

/** The frozen payload schema an AGENT publish stamped (`compiledConfig.contextSchema.payloadSchema`). */
export function frozenAgentPayloadSchema(compiledConfig: unknown): Record<string, unknown> | null {
  const contextSchema = isPlainObject(compiledConfig) ? compiledConfig.contextSchema : undefined;
  const payloadSchema = isPlainObject(contextSchema) ? contextSchema.payloadSchema : undefined;
  return isPlainObject(payloadSchema) ? payloadSchema : null;
}

/** The version number an AGENT's compiled config records, when it has one. */
function frozenAgentVersionNumber(compiledConfig: unknown): number | null {
  const contextSchema = isPlainObject(compiledConfig) ? compiledConfig.contextSchema : undefined;
  const versionNumber = isPlainObject(contextSchema) ? contextSchema.versionNumber : undefined;
  return typeof versionNumber === 'number' ? versionNumber : null;
}

/**
 * A WORKFLOW definition's binding and verdict. The binding comes from the column publish
 * stamps (`contextSchemaFollowsLatest`), never from re-reading the authored graph: the column
 * IS the published answer, and a graph edit after publish cannot change what already shipped.
 */
export function workflowUsageVerdict(
  row: { contextSchemaFollowsLatest?: boolean | null; contextSchemaVersionNumber?: number | null; compiledConfig?: unknown },
  targetPayloadSchema: Record<string, unknown>,
): ContextSchemaBoundUsage {
  const binding: ContextSchemaBinding = row.contextSchemaFollowsLatest === true ? 'latest' : 'pinned';
  const boundVersion = typeof row.contextSchemaVersionNumber === 'number' ? row.contextSchemaVersionNumber : null;
  return {
    binding,
    boundVersion,
    ...usageVerdict({
      binding,
      boundVersion,
      targetPayloadSchema,
      frozenPayloadSchema: binding === 'latest' ? null : frozenTriggerPayloadSchema(row.compiledConfig),
    }),
  };
}

/**
 * An AGENT's binding and verdict.
 *
 * An agent pins by COLUMN (`Agent.contextSchemaVersionNumber`), not by a graph flag: a null
 * there means "whatever the tenant has pinned", exactly what `resolveReference` does with an
 * absent version number. `boundVersion` prefers the version the compiled bytes actually record,
 * because that is the version the frozen payload schema came from.
 */
export function agentUsageVerdict(
  row: { contextSchemaVersionNumber?: number | null; compiledConfig?: unknown },
  targetPayloadSchema: Record<string, unknown>,
): ContextSchemaBoundUsage {
  const pinnedVersion = typeof row.contextSchemaVersionNumber === 'number' ? row.contextSchemaVersionNumber : null;
  const binding: ContextSchemaBinding = pinnedVersion == null ? 'latest' : 'pinned';
  const boundVersion = frozenAgentVersionNumber(row.compiledConfig) ?? pinnedVersion;
  return {
    binding,
    boundVersion,
    ...usageVerdict({
      binding,
      boundVersion,
      targetPayloadSchema,
      frozenPayloadSchema: binding === 'latest' ? null : frozenAgentPayloadSchema(row.compiledConfig),
    }),
  };
}
