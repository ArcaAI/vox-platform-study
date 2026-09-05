import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';

/**
 * TASK-885 — the pure half of workflow import/export: turning the ROW IDS a node config
 * references into PORTABLE KEYS, and back.
 *
 * ## Why a rewrite exists at all
 *
 * A workflow graph is authored against one tenant's catalogues. `promptTemplateId`,
 * `documentTemplateId`, `mcpServerId` and `providerConfigRef.routingPolicyId` are all ROW IDS,
 * and none of those tables is a SYSTEM-shared read — every tenant gets its own rows with its own
 * ids (`seed/07-prompt-template.ts`). Copying an id across a tenant boundary therefore produces a
 * reference the destination can neither read nor repair, which is exactly what
 * `WorkflowDefinitionService.assertNoUnresolvableCatalogBindings` refuses to do on the clone
 * path. Export is the other answer to the same problem: carry the KEY, not the id, and resolve
 * it against the importing tenant's own catalogue.
 *
 * This is the same discipline `AgentPromotionService` states as "promotion copies VALUES, never
 * REFERENCES" — expressed here as a value transform rather than a deep copy, because an export
 * has no target tenant to copy into.
 *
 * ## The reference table
 *
 * | In the graph | Portable form | Why that key |
 * |---|---|---|
 * | `promptTemplateId` | `promptTemplateRef: { name }` | `PromptTemplate @@unique([tenantId, name])` |
 * | `documentTemplateId` | `documentTemplateRef: { slug }` | `DocumentTemplate @@unique([tenantId, slug])` |
 * | `mcpServerId` | `mcpServerRef: { name }` | `McpServer @@unique([tenantId, name])` |
 * | `providerConfigRef.routingPolicyId` | `providerConfigRef.taskKey` | the schema's own alternative — resolve the tenant's ELECTED default instead of pinning one row |
 * | `agentRef: { slug, versionNumber }` | `agentRef: { slug }` | already portable; the version pin is not |
 * | `modelSlug` | verbatim | already portable |
 *
 * Two things are removed rather than translated:
 *
 * - **`evalGate` is STRIPPED.** `goldenSetId` names a corpus of Vault-Transit-encrypted PHI, so
 *   not even the pointer leaves the tenant — the rule promotion already applies, and the reason
 *   an exported bundle can be handed to someone without handing them a claim on that data.
 * - **Version pins are dropped** (`promptVersionNumber`, `documentVersionNumber`,
 *   `agentRef.versionNumber`). A pin numbers a version inside ANOTHER tenant's lineage; carried
 *   over it either dangles or, worse, silently names a different prompt. This is the reasoning
 *   `AgentPromotionService` gives for dropping `promptVersionNumber` on the promotion path.
 *
 * ## Discovery is by KEY NAME, recursively
 *
 * Not by node type, and not at the top level of `config`. A guardrail node carries
 * `policies[].promptTemplateId` (`node-config-schemas.ts:1143`) — nested inside an array — so a
 * shallow walk would export a graph with a live foreign row id in it and no reference reported.
 * The walk therefore descends every plain object and array, exactly as
 * `collectPromptBindings` keys off the PRESENCE of a binding rather than a node-type allow-list.
 *
 * ## Resolution is the caller's job
 *
 * These functions are pure: they take a pre-built map because every lookup is a database read.
 * The caller collects (`collectRowReferences` / `collectPortableReferences`), resolves, and
 * transforms. `toTenantGraph` reports as `unresolved` only the kinds it REWRITES; the
 * already-portable kinds (`agent`, `model`, `routingTask`) are reported in `references` for the
 * service to verify against the importing tenant's visible catalogue.
 */

/** A reference the graph makes by ROW ID — meaningless outside the tenant that owns the row. */
export type RowReferenceKind = 'promptTemplate' | 'documentTemplate' | 'mcpServer' | 'routingPolicy';

/** A reference expressed by a PORTABLE key — a name, a slug, or a task key. Never a row id. */
export type PortableReferenceKind = 'promptTemplate' | 'documentTemplate' | 'mcpServer' | 'routingTask' | 'agent' | 'model';

export interface RowReference {
  nodeId: string;
  kind: RowReferenceKind;
  id: string;
}

export interface PortableReference {
  nodeId: string;
  kind: PortableReferenceKind;
  key: string;
}

export interface PortableGraphResult {
  /** The graph with every row id replaced by its portable key, gates stripped and pins dropped. */
  graph: WorkflowGraph;
  /** Every portable reference the exported graph makes. This is the manifest an import verifies. */
  references: PortableReference[];
  /** Row references the caller supplied no key for — the graph carries neither the id nor a ref. */
  unresolved: RowReference[];
  /** Every row-id reference found, resolved or not. */
  rowReferences: RowReference[];
}

export interface TenantGraphResult {
  /** The graph with every rewritten reference resolved into THIS tenant's row ids. */
  graph: WorkflowGraph;
  /** Every portable reference the bundle makes, including the verify-only kinds. */
  references: PortableReference[];
  /** Rewritten references this tenant has no row for. The caller turns these into a 409. */
  unresolved: PortableReference[];
}

/** `<kind>:<id>` on export, `<kind>:<key>` on import — the lookup key both maps are built with. */
export function referenceMapKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

/** The three id ⇄ ref rewrites, and the pin each one drops with it. */
const REWRITTEN = [
  { kind: 'promptTemplate', idKey: 'promptTemplateId', refKey: 'promptTemplateRef', field: 'name', pin: 'promptVersionNumber' },
  { kind: 'documentTemplate', idKey: 'documentTemplateId', refKey: 'documentTemplateRef', field: 'slug', pin: 'documentVersionNumber' },
  { kind: 'mcpServer', idKey: 'mcpServerId', refKey: 'mcpServerRef', field: 'name', pin: null },
] as const satisfies readonly { kind: PortableReferenceKind; idKey: string; refKey: string; field: string; pin: string | null }[];

const EVAL_GATE_KEY = 'evalGate';
const AGENT_REF_KEY = 'agentRef';
const MODEL_SLUG_KEY = 'modelSlug';
const PROVIDER_CONFIG_REF_KEY = 'providerConfigRef';
const ROUTING_POLICY_ID_KEY = 'routingPolicyId';
const TASK_KEY = 'taskKey';

const DROPPED_PINS = new Set(REWRITTEN.map((entry) => entry.pin).filter((pin): pin is string => pin !== null));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nodesOf(graph: WorkflowGraph | null | undefined): WorkflowGraphNode[] {
  return graph && Array.isArray(graph.nodes) ? graph.nodes : [];
}

/** Rebuild a graph around per-node configs, preserving everything else verbatim. */
function withConfigs(graph: WorkflowGraph, configs: Record<string, unknown>[]): WorkflowGraph {
  return { ...graph, nodes: nodesOf(graph).map((node, index) => ({ ...node, config: configs[index] })) } as WorkflowGraph;
}

// ===========================================================================
// Export — row ids -> portable keys
// ===========================================================================

export function toPortableGraph(graph: WorkflowGraph, keyById: ReadonlyMap<string, string>): PortableGraphResult {
  const references: PortableReference[] = [];
  const unresolved: RowReference[] = [];
  const rowReferences: RowReference[] = [];

  const configs = nodesOf(graph).map((node) => {
    const nodeId = node.id;

    const rewriteObject = (source: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(source)) {
        // A golden set is encrypted PHI. Nothing about it travels.
        if (key === EVAL_GATE_KEY) continue;
        // A pin numbers a version in the SOURCE lineage; it cannot mean anything elsewhere.
        if (DROPPED_PINS.has(key)) continue;

        const rewrite = REWRITTEN.find((entry) => entry.idKey === key);
        if (rewrite) {
          const id = typeof value === 'string' && value.length > 0 ? value : null;
          if (!id) continue;
          const row: RowReference = { nodeId, kind: rewrite.kind, id };
          rowReferences.push(row);
          const resolved = keyById.get(referenceMapKey(rewrite.kind, id));
          if (resolved === undefined) {
            // Deliberately emits NOTHING rather than the raw id: a bundle that carries a foreign
            // row id is the failure this whole module exists to prevent.
            unresolved.push(row);
            continue;
          }
          out[rewrite.refKey] = { [rewrite.field]: resolved };
          references.push({ nodeId, kind: rewrite.kind, key: resolved });
          continue;
        }

        if (key === PROVIDER_CONFIG_REF_KEY && isPlainObject(value)) {
          out[key] = rewriteProviderConfigRef(value, nodeId);
          continue;
        }

        if (key === AGENT_REF_KEY && isPlainObject(value)) {
          const slug = readString(value, 'slug');
          if (!slug) continue;
          out[key] = { slug };
          references.push({ nodeId, kind: 'agent', key: slug });
          continue;
        }

        if (key === MODEL_SLUG_KEY && typeof value === 'string' && value.length > 0) {
          out[key] = value;
          references.push({ nodeId, kind: 'model', key: value });
          continue;
        }

        out[key] = rewriteValue(value);
      }

      return out;
    };

    const rewriteValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewriteValue);
      if (isPlainObject(value)) return rewriteObject(value);
      return value;
    };

    /**
     * `providerConfigRef` declares "exactly one of `routingPolicyId` / `taskKey`". A PINNED row
     * id is downgraded to the task key that row serves, which is not a loss of meaning so much
     * as the portable statement of the same intent: resolve the importing tenant's own elected
     * configuration for this task through the tenant -> SYSTEM cascade.
     */
    const rewriteProviderConfigRef = (source: Record<string, unknown>, nodeIdForRef: string): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        if (key === ROUTING_POLICY_ID_KEY) {
          const id = typeof value === 'string' && value.length > 0 ? value : null;
          if (!id) continue;
          const row: RowReference = { nodeId: nodeIdForRef, kind: 'routingPolicy', id };
          rowReferences.push(row);
          const resolved = keyById.get(referenceMapKey('routingPolicy', id));
          if (resolved === undefined) {
            unresolved.push(row);
            continue;
          }
          out[TASK_KEY] = resolved;
          references.push({ nodeId: nodeIdForRef, kind: 'routingTask', key: resolved });
          continue;
        }
        if (key === TASK_KEY && typeof value === 'string' && value.length > 0) {
          out[key] = value;
          references.push({ nodeId: nodeIdForRef, kind: 'routingTask', key: value });
          continue;
        }
        out[key] = rewriteValue(value);
      }
      return out;
    };

    return isPlainObject(node.config) ? rewriteObject(node.config) : {};
  });

  return { graph: withConfigs(graph, configs), references, unresolved, rowReferences };
}

/** Every row-id reference the graph makes, in node order. */
export function collectRowReferences(graph: WorkflowGraph): RowReference[] {
  return toPortableGraph(graph, new Map()).rowReferences;
}

// ===========================================================================
// Import — portable keys -> this tenant's row ids
// ===========================================================================

export function toTenantGraph(graph: WorkflowGraph, idByKey: ReadonlyMap<string, string>): TenantGraphResult {
  const references: PortableReference[] = [];
  const unresolved: PortableReference[] = [];

  const configs = nodesOf(graph).map((node) => {
    const nodeId = node.id;

    const resolveObject = (source: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(source)) {
        const rewrite = REWRITTEN.find((entry) => entry.refKey === key);
        if (rewrite) {
          const portableKey = isPlainObject(value) ? readString(value, rewrite.field) : null;
          if (!portableKey) continue;
          const reference: PortableReference = { nodeId, kind: rewrite.kind, key: portableKey };
          references.push(reference);
          const id = idByKey.get(referenceMapKey(rewrite.kind, portableKey));
          if (id === undefined) {
            unresolved.push(reference);
            continue;
          }
          out[rewrite.idKey] = id;
          continue;
        }

        if (key === PROVIDER_CONFIG_REF_KEY && isPlainObject(value)) {
          const taskKey = readString(value, TASK_KEY);
          if (taskKey) references.push({ nodeId, kind: 'routingTask', key: taskKey });
          out[key] = resolveValue(value);
          continue;
        }

        if (key === AGENT_REF_KEY && isPlainObject(value)) {
          const slug = readString(value, 'slug');
          if (slug) references.push({ nodeId, kind: 'agent', key: slug });
          out[key] = resolveValue(value);
          continue;
        }

        if (key === MODEL_SLUG_KEY && typeof value === 'string' && value.length > 0) {
          references.push({ nodeId, kind: 'model', key: value });
          out[key] = value;
          continue;
        }

        out[key] = resolveValue(value);
      }

      return out;
    };

    const resolveValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveValue);
      if (isPlainObject(value)) return resolveObject(value);
      return value;
    };

    return isPlainObject(node.config) ? resolveObject(node.config) : {};
  });

  return { graph: withConfigs(graph, configs), references, unresolved };
}

/** Every portable reference a bundle makes, in node order — the set an import must verify. */
export function collectPortableReferences(graph: WorkflowGraph): PortableReference[] {
  return toTenantGraph(graph, new Map()).references;
}
