/**
 * TASK-816 Phase 1 (DD-10) — `llmBinding` on node config.
 *
 * `AiTaskDefault` semantics RELOCATE onto a per-node binding; they are not deleted. This suite
 * pins the SHAPE of that relocation and the SET of node types that may carry it.
 *
 * ## Why the binding names a SLUG and nothing else
 *
 * `AiTaskDefault` expresses exactly three things: `taskKey` (already a node config key),
 * `modelSlug` (a reference into `AiModel`, resolved `[tenant, SYSTEM]` preferring tenant), and
 * `configJson` (which no runtime reads). Everything a caller finally sends to `apps/text` —
 * `provider` and the provider-native model id — is DERIVED from the `AiModel` row that slug
 * names. So `modelSlug` is the whole of the transferable selection, and every other field the
 * ticket sketched would either be a hardcoded engine/model literal (`00-project-context.md`
 * §Configuration Principles rule 1) or a SECOND place to say something the platform already
 * models:
 *
 * | Sketched field | Where it already lives |
 * |---|---|
 * | `provider` | derived from `AiModel.provider` for the bound slug |
 * | `model` | derived from `AiModel.sourceUri` for the bound slug |
 * | `contextLength` | `AiRuntimeProfile.contextLength`, keyed by the same `(provider, modelSlug)` |
 * | `maxTokens` / `temperature` | already top-level config keys on every generation schema |
 * | `promptInstruction` | `promptTemplateId` + `promptVersionNumber` (DD-11), governed and pinned |
 *
 * ## Why the SET is derived from `taskKey`
 *
 * A node type that declares `taskKey` is, by construction, a node whose model is selected per
 * node through the `AiTaskDefault` cascade — that is what the key IS. `llmBinding` refines the
 * same selection, so deriving membership from the same signal means the next generation node
 * someone registers cannot be forgotten (the reason `withRuntimeProperties` folds
 * `timeoutSeconds`/`retry` in rather than pasting them into ~50 literals).
 */
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

type Props = Record<string, Record<string, unknown>>;

const propertiesOf = (key: string): Props => NODE_CONFIG_SCHEMAS[key].properties as Props;

/** Node types whose config schema declares `taskKey` — the AiTaskDefault routing key. */
const taskKeyed = Object.keys(NODE_CONFIG_SCHEMAS).filter((key) => Object.hasOwn(propertiesOf(key), 'taskKey'));

describe('TASK-816 — `llmBinding` is declared on exactly the node types that select a model', () => {
  it('every node type that declares `taskKey` also declares `llmBinding`', () => {
    for (const key of taskKeyed) {
      expect(Object.hasOwn(propertiesOf(key), 'llmBinding'), `${key} declares taskKey but no llmBinding`).toBe(true);
    }
  });

  it('covers the eleven catalogue + palette generation node types, and no others', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).filter((key) => Object.hasOwn(propertiesOf(key), 'llmBinding')).sort()).toEqual([
      'agent.discharge_summary',
      'agent.grammar',
      'agent.important_findings',
      'agent.presummarization',
      'agent.summarization',
      'consultation.proposeCorrections',
      'consultation.realtimeSummary',
      'consultation.suggestions',
      'consultation.synthesize',
      'generate.text',
      'guard.groundedness',
    ]);
  });

  it('`guard.groundedness` can AUTHOR the `taskKey` its activity already reads', () => {
    // `nodes/guards.py:203` -> `task_key = payload.config.get("taskKey") or "text.finalize"`.
    // Every schema here is `additionalProperties: false`, so until now the runtime honoured a
    // routing key an admin could not set — the same two-halves-disagree defect the ADDENDUM
    // closed for `timeoutSeconds`/`retry`.
    expect(Object.hasOwn(propertiesOf('guard.groundedness'), 'taskKey')).toBe(true);
  });

  it('does NOT reach the sensor nodes, which resolve no per-node selection', () => {
    // `consultation_verify.py` calls `get_policy(tenant_id)` with NO task key: its model comes
    // from the `HarnessPolicy` columns, which is Phase 2's subject, not this one's.
    for (const key of ['consultation.sensors', 'consultation.inferentialSensors', 'agent.dna_redaction', 'agent.ner']) {
      expect(Object.hasOwn(propertiesOf(key), 'llmBinding'), `${key} must not carry an llmBinding`).toBe(false);
    }
  });
});

describe('TASK-816 — the binding SHAPE', () => {
  const binding = () => propertiesOf('generate.text').llmBinding as {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };

  it('is a closed object requiring exactly `modelSlug`', () => {
    const schema = binding();
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['modelSlug']);
    expect(Object.keys(schema.properties)).toEqual(['modelSlug']);
  });

  it('names a SLUG — never a provider, a model id, or a prompt', () => {
    const props = binding().properties;
    expect(props.modelSlug.type).toBe('string');
    // The four fields that would each be a second source of truth (or a hardcoded literal).
    for (const forbidden of ['provider', 'model', 'contextLength', 'maxTokens', 'temperature', 'promptInstruction']) {
      expect(Object.hasOwn(props, forbidden), `llmBinding must not declare ${forbidden}`).toBe(false);
    }
  });

  it('is ONE shared frozen object, so the eleven declaration sites cannot drift', () => {
    const first = propertiesOf('generate.text').llmBinding;
    for (const key of taskKeyed) {
      expect(propertiesOf(key).llmBinding).toBe(first);
    }
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('is NOT required by any schema — every already-published graph stays valid', () => {
    for (const key of taskKeyed) {
      const required = (NODE_CONFIG_SCHEMAS[key].required ?? []) as string[];
      expect(required).not.toContain('llmBinding');
    }
  });

  it('keeps every touched schema authorable and attached to the registry descriptor', () => {
    for (const key of taskKeyed) {
      expect(authorableJsonSchemaProblems(NODE_CONFIG_SCHEMAS[key])).toEqual([]);
      expect(WORKFLOW_NODE_REGISTRY[key].configSchema).toBe(NODE_CONFIG_SCHEMAS[key]);
    }
  });
});
