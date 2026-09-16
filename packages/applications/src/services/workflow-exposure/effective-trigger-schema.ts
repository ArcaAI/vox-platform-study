/**
 * The schema a RUN is actually validated against, and where a follow-latest trigger gets it.
 *
 * ## The promise this keeps
 *
 * A compiled workflow artifact freezes ONE derived payload schema onto its `core.trigger`
 * (`config.contextSchema.resolved`), and `interpreter_core_trigger` validates the run payload
 * against those bytes and nothing else — no database read, ever. That is exactly right for a
 * trigger the author PINNED to a schema version.
 *
 * It is exactly wrong for a trigger the author bound to the tenant's PIN. The studio's
 * "Follow latest (currently vN)" option tells the admin, in those words, that a republish of
 * the schema changes what the trigger accepts; the artifact said otherwise, so a tenant that
 * added a kind and re-opened a consultation had its governing run fail on the first node with
 * an undeclared-property error. Two surfaces, two answers, and the one the admin was shown was
 * the one that was not true.
 *
 * ## Where the promise is kept, and why here
 *
 * Both dispatch paths — consultation open and `POST workflows/:slug/runs` — already mint a
 * PER-RUN claim-checked copy of the compiled config immediately before the run starts. That
 * copy is the only place a follow-latest answer can be written without either (a) making the
 * interpreter read a schema row, which breaks the invariant the whole compiled artifact exists
 * to uphold, or (b) rewriting the PUBLISHED artifact, which would change a checksummed
 * immutable row under a run already in flight.
 *
 * So the rule, in full:
 *
 *   * a **PINNED** trigger validates against the schema the workflow was published with;
 *   * a **FOLLOW-LATEST** trigger validates against the tenant's pin at dispatch — the gateway
 *     resolves it and freezes it into THAT RUN's config before the run starts;
 *   * the interpreter never reads a schema row.
 *
 * ## Why this file is pure
 *
 * Three callers have to agree: the consultation dispatcher, the exposure plane's invoke, and
 * the PRE-DISPATCH compatibility check at `open` that refuses an incompatible payload before
 * anything is written. If `open` measured a payload against one schema and the run were then
 * validated against another, the refusal would be worse than no refusal at all — it would be
 * confidently wrong. One derivation, one place, no I/O; the callers hand the pin's bytes in.
 */

import {
  openBindingsFromDefinition,
  payloadSchemaFromDefinition,
  userIdentityBindingFromDefinition,
} from '../consultation-context-schema/context-schema-definition';

/** The `core.trigger` node type, restated here so this leaf takes no value dependency. */
const TRIGGER_NODE_TYPE = 'core.trigger';

/**
 * The tenant's CURRENT pin for the schema a trigger names: a version number and the immutable
 * version row's `definition`.
 *
 * Deliberately the RAW definition rather than a pre-derived bundle. The three things a trigger
 * freezes — the payload schema, the identity binding and the open-time bindings — must all
 * describe the SAME version, and the only way to guarantee that is to derive all three from one
 * definition in one pass, with the same functions `ConsultationContextSchemaService.resolveReference`
 * uses. A caller that handed in a payload schema from one version and bindings from another
 * would produce a run config no schema row ever described.
 */
export interface ContextSchemaPin {
  versionNumber: number;
  definition: unknown;
}

/** What the trigger's compiled bytes say about HOW it binds its context schema. */
export interface TriggerContextBinding {
  /** TRUE only when publish stamped it. An absent flag is PINNED, never "unknown". */
  followsLatest: boolean;
  /** The schema the trigger names by reference, or `null` for an inline or unbound trigger. */
  schemaId: string | null;
}

export interface EffectiveTriggerConfig {
  /** The compiled config to mint the per-run `configRef` from. The INPUT itself when nothing changed. */
  config: unknown;
  /** The payload schema a run under this config is validated against, or `null` when none is frozen. */
  resolved: Record<string, unknown> | null;
  /** The schema version `resolved` came from, for a rewritten config only. */
  effectiveVersionNumber: number | null;
  /** Whether the trigger's frozen schema was replaced. False means `config` is the input, unchanged. */
  rewritten: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The compiled `core.trigger` node's own `config.contextSchema` block, or `undefined`. */
function triggerContextSchemaBlock(compiledConfig: unknown): Record<string, unknown> | undefined {
  const stages = isPlainObject(compiledConfig) ? compiledConfig.stages : undefined;
  if (!Array.isArray(stages)) return undefined;
  for (const stage of stages) {
    const nodes = isPlainObject(stage) ? stage.nodes : undefined;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!isPlainObject(node) || node.type !== TRIGGER_NODE_TYPE) continue;
      const config = isPlainObject(node.config) ? node.config : undefined;
      const contextSchema = config ? config.contextSchema : undefined;
      if (isPlainObject(contextSchema)) return contextSchema;
    }
  }
  return undefined;
}

/**
 * How the compiled trigger binds its schema — the question a caller asks BEFORE deciding
 * whether it needs to read a pin at all.
 *
 * Total: anything that is not a compiled config carrying a reference-bound `core.trigger`
 * answers `{ followsLatest: false, schemaId: null }`, which reads as "nothing to re-resolve"
 * at every call site.
 */
export function triggerContextBinding(compiledConfig: unknown): TriggerContextBinding {
  const contextSchema = triggerContextSchemaBlock(compiledConfig);
  const schemaId =
    typeof contextSchema?.contextSchemaId === 'string' && contextSchema.contextSchemaId.length > 0 ? contextSchema.contextSchemaId : null;
  return { followsLatest: contextSchema?.followsLatest === true && schemaId !== null, schemaId };
}

/** Replace the trigger node's `contextSchema` block, leaving every other byte where it was. */
function withTriggerContextSchema(compiledConfig: Record<string, unknown>, contextSchema: Record<string, unknown>): Record<string, unknown> {
  const stages = Array.isArray(compiledConfig.stages) ? compiledConfig.stages : [];
  return {
    ...compiledConfig,
    stages: stages.map((stage) => {
      if (!isPlainObject(stage) || !Array.isArray(stage.nodes)) return stage;
      return {
        ...stage,
        nodes: stage.nodes.map((node) => {
          if (!isPlainObject(node) || node.type !== TRIGGER_NODE_TYPE) return node;
          const config = isPlainObject(node.config) ? node.config : {};
          return { ...node, config: { ...config, contextSchema } };
        }),
      };
    }),
  };
}

/**
 * The config THIS RUN executes against.
 *
 * A pinned trigger (or a caller with no pin to offer) gets its input back by identity — the
 * cheapest possible statement that nothing changed, and the one a claim-check mint can rely on.
 *
 * A follow-latest trigger gets a copy whose trigger node carries the pin's derived bytes:
 * `resolved`, plus `userIdentity` / `openBindings` re-derived from the SAME definition, plus
 * `effectiveVersionNumber` naming the version they all came from. The AUTHORED half of the block
 * (`contextSchemaId`, `followsLatest`) is preserved: that is what the author wrote and what a
 * re-publish re-resolves. The frozen markers are REPLACED rather than merged — a pin that
 * declares no identity field must not leave the previous version's field standing, or a run
 * would resolve a clinician from a property the tenant deleted.
 *
 * `checksum` is deliberately NOT recomputed. It certifies the PUBLISHED artifact, and this copy
 * is not one: it is a per-run derivative that exists for the length of one dispatch, addressed
 * by a claim-check ref nothing else reads. Recomputing it would mint a checksum for bytes no
 * publish ever produced, which is strictly more misleading than carrying the real one.
 */
export function effectiveTriggerConfig(compiledConfig: unknown, currentPin: ContextSchemaPin | null): EffectiveTriggerConfig {
  const contextSchema = triggerContextSchemaBlock(compiledConfig);
  const frozen = isPlainObject(contextSchema?.resolved) ? (contextSchema.resolved as Record<string, unknown>) : null;
  const unchanged: EffectiveTriggerConfig = { config: compiledConfig, resolved: frozen, effectiveVersionNumber: null, rewritten: false };

  const { followsLatest } = triggerContextBinding(compiledConfig);
  if (!followsLatest || currentPin === null || !isPlainObject(compiledConfig) || contextSchema === undefined) return unchanged;

  const resolved = payloadSchemaFromDefinition(currentPin.definition);
  const userIdentity = userIdentityBindingFromDefinition(currentPin.definition);
  const openBindings = openBindingsFromDefinition(currentPin.definition);

  // Rebuilt from the authored half rather than spread over the frozen one, so a marker the pin
  // no longer declares disappears instead of surviving as a stale instruction.
  const { resolved: _frozenResolved, userIdentity: _frozenIdentity, openBindings: _frozenBindings, ...authored } = contextSchema;

  const next = {
    ...authored,
    resolved,
    ...(userIdentity ? { userIdentity } : {}),
    ...(Object.keys(openBindings).length > 0 ? { openBindings } : {}),
    effectiveVersionNumber: currentPin.versionNumber,
  };

  return {
    config: withTriggerContextSchema(compiledConfig, next),
    resolved,
    effectiveVersionNumber: currentPin.versionNumber,
    rewritten: true,
  };
}
