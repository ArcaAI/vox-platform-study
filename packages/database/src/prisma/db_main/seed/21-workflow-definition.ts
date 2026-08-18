import type { CorePrismaClient } from '../../../client';
import { SEED_WORKFLOW_DEFINITION_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * WorkflowDefinition Seed — the platform-default Summarization definition (TASK-720 Task 6).
 *
 * ONE new row is new here — no deployed row exists to drift, unlike `PromptTemplate`
 * (assessment README §3.4, cited by rule 02 §Seeds: "Deployed rows do not re-seed and have
 * drifted — this needs a data migration, not just a seed edit"). A seed alone is therefore
 * correct THIS TIME. Say so explicitly so a later reader does not assume the general case:
 * once this row exists in any deployed environment, a further shape change to `graph` /
 * `compiledConfig` needs a data migration, not an edit to this file (the same rule that makes
 * `PromptTemplate` care).
 *
 * This is the row `design.md` §Data flow / §Error handling describes: "the dispatcher resolves
 * the tenant's active published version — or the platform default config" / "Temporal
 * unreachable → platform default config". SYSTEM-tenant, `status: PUBLISHED`, `isActive: true`.
 *
 * ## Honesty note on `graph` / `compiledConfig` / `validationReport` (read before editing)
 *
 * `graph` and `compiledConfig` below are NOT hand-typed JSON — they are the literal output of
 * `packages/workflow-contract`'s real `validate()`/`compile()` engine (TASK-716), run against
 * this exact node set via a throwaway script and pasted here verbatim. This keeps the seed
 * provably byte-consistent with the one compiler implementation rather than a second,
 * hand-maintained copy of its output shape. `packages/database` deliberately does NOT take a
 * runtime dependency on `@arcaai/workflow-contract` for this (`packages/database/package.json`
 * is unmodified) — adding one would touch the shared root `pnpm-lock.yaml` while sibling
 * TASK-7xx agents share this working tree, which is exactly the collision surface the
 * orchestrator's hard rules ask every ticket to avoid. If the graph ever needs to change,
 * regenerate both blobs from `compile()`/`validate()` again rather than hand-editing the JSON.
 *
 * `activity` strings inside `compiledConfig.stages[].nodes[]` are byte-identical to the
 * Temporal-registered names in `docs/implementation/TASK-720-Palette-Summarization/contracts/palette.md`'s
 * node table — a mismatch there is exactly what makes the interpreter's S-4 dispatch check
 * `SKIPPED(reason="activity_mismatch")` every node (see that doc + `execution-semantics.md` §10).
 *
 * `registryChecksum` — UPDATED (TASK-720 Task 5 pass): TASK-734 built the code-owned
 * `WORKFLOW_NODE_REGISTRY` (`packages/workflow-contract/src/node-registry.ts`) and this ticket's
 * own Task 5 populated its five summarization-palette entries, so the placeholder named above the
 * original pass ("`'task-720-seed-placeholder-pending-task-715-registry'`") is gone — this row now
 * carries the REAL `registryChecksum()` output (recomputed the same way as `graph`/
 * `compiledConfig`: a throwaway script against the built `packages/workflow-contract/dist`,
 * pasted here verbatim, never hand-typed). `graphChecksum` is unchanged (the authored `GRAPH` did
 * not change), but `compiledConfig.checksum` DID change, because it hashes over
 * `compiledConfig.registryChecksum` too — both were recomputed together from the same `compile()`
 * run so they stay internally consistent.
 *
 * `validationReport` is real — it is `validate()`'s actual output — but it is SCOPED to only
 * the `WF-SUMM-*` structural rules TASK-720 added (`packages/workflow-contract/src/rule-catalogue.ts`),
 * not the full `DRAFT_SUMMARIZATION_RULE_SET`. Running the full catalogue against this graph
 * today produces ERROR findings from the pre-existing, palette-independent `WF-S-002/003/004/007`
 * rules, which assume literal `core.start`/`core.end` node types this palette does not use (see
 * `contracts/palette.md`'s "Mandatory-subgraph rule set" section for the full explanation) — a
 * TASK-716 rule-design gap, not something this ticket fixes. Claiming a clean report against
 * rules that cannot structurally pass for this palette would be dishonest, so this row's report
 * says exactly what it checked and nothing more. There is also no real `WorkflowValidatorService`
 * (TASK-716 Task 8, gated on the same missing registry) to have produced a *server-side*
 * certification — this is the compiler engine's own pure verdict on the graph it compiled, which
 * is the most that can honestly be claimed in this session.
 */

const PLATFORM_DEFAULT_ID = SEED_WORKFLOW_DEFINITION_IDS.PLATFORM_DEFAULT_SUMMARIZATION;
const SLUG = 'platform-default-summarization';
const COMPILED_AT = '2026-08-16T00:00:00.000Z';
// Real `registryChecksum()` output from `packages/workflow-contract/src/node-registry.ts`'s
// `WORKFLOW_NODE_REGISTRY` (7 entries: noop/passthrough + the 5 summarization-palette node
// types) — recomputed via a throwaway script against the built dist, see the module docstring.
const REGISTRY_CHECKSUM = '2ae7222a1e7dc97191309a71a6e438a5088d07174f649d541e1d98878478f97b';

const GRAPH = {
  version: 1,
  nodes: [
    {
      id: 'n_input',
      type: 'input.context_binding',
      config: {
        contextSchema: {
          schemaVersion: '1.0',
          kinds: [
            {
              key: 'source_text',
              label: 'Source text',
              primitive: 'TEXT',
              phiClass: 'NON_PHI',
              cardinality: 'ONE',
              lifecycle: 'ANY',
              producedBy: ['CLIENT'],
              required: true,
            },
          ],
        },
        bindings: [{ kindKey: 'source_text', from: 'payload.text' }],
      },
    },
    {
      id: 'n_gen',
      type: 'generate.text',
      config: { taskKey: 'text.finalize', onError: 'fail' },
    },
    {
      id: 'n_guard',
      type: 'guardrail.check',
      config: { guardrailType: 'content_safety', failOn: 'unsafe_or_unknown', onFail: 'mark' },
    },
    {
      id: 'n_out',
      type: 'output.deliver',
      config: { outputs: [{ key: 'summary', primitive: 'TEXT' }] },
    },
  ],
  edges: [
    { id: 'e1', from: 'n_input', fromPort: 'out', to: 'n_gen', toPort: 'in' },
    { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_guard', toPort: 'in' },
    { id: 'e3', from: 'n_guard', fromPort: 'out', to: 'n_out', toPort: 'in' },
  ],
};

// Verbatim `compile()` output — see the module docstring for how this was produced.
const COMPILED_CONFIG = {
  formatVersion: 1,
  definitionId: PLATFORM_DEFAULT_ID,
  slug: SLUG,
  versionNumber: 1,
  tenantId: SYSTEM_TENANT_ID,
  paletteKey: 'summarization',
  compiledAt: COMPILED_AT,
  compilerVersion: 'task-720-seed-1',
  registryChecksum: REGISTRY_CHECKSUM,
  ruleSetVersion: 1,
  stages: [
    {
      stageIndex: 0,
      nodes: [
        {
          nodeId: 'n_input',
          type: 'input.context_binding',
          activity: 'interpreter.context_binding',
          config: GRAPH.nodes[0]!.config,
          timeoutSeconds: 60,
          retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
          inputs: [],
          onError: 'fail',
          emitsTrajectory: true,
        },
      ],
    },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'n_gen',
          type: 'generate.text',
          activity: 'interpreter.text_generate',
          config: GRAPH.nodes[1]!.config,
          timeoutSeconds: 60,
          retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
          inputs: [{ fromNodeId: 'n_input', fromPort: 'out', toPort: 'in' }],
          onError: 'fail',
          emitsTrajectory: true,
        },
      ],
    },
    {
      stageIndex: 2,
      nodes: [
        {
          nodeId: 'n_guard',
          type: 'guardrail.check',
          activity: 'interpreter.guardrail_check',
          config: GRAPH.nodes[2]!.config,
          timeoutSeconds: 60,
          retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
          inputs: [{ fromNodeId: 'n_gen', fromPort: 'out', toPort: 'in' }],
          onError: 'fail',
          emitsTrajectory: true,
        },
      ],
    },
    {
      stageIndex: 3,
      nodes: [
        {
          nodeId: 'n_out',
          type: 'output.deliver',
          activity: 'interpreter.deliver',
          config: GRAPH.nodes[3]!.config,
          timeoutSeconds: 60,
          retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
          inputs: [{ fromNodeId: 'n_guard', fromPort: 'out', toPort: 'in' }],
          onError: 'fail',
          emitsTrajectory: true,
        },
      ],
    },
  ],
  gates: [],
  policyBindings: {
    guardrailProfile: 'STANDARD',
    redactionRuleSetId: null,
    promptTemplateRefs: [],
    contextSchemaVersionId: null,
    entitlementKeys: [],
  },
  caps: { maxTotalSeconds: 3600, maxNodeSeconds: 900, maxAttempts: 5 },
  // sha256 over canonicalJson of every field above (computed by `compile()` — see docstring).
  checksum: 'a0a699f5200aeb43dc8438dc6243c75519569995e029fba16c0882e1ef7cb511',
};

// sha256 over canonicalJson(GRAPH), computed by the same `canonicalJson` the compiler uses.
const GRAPH_CHECKSUM = '6b2d6d9253d139f2f71cb61b3f92045cea83434c84ab4273de8ec7b6f8bc1644';
// Column-level copy of COMPILED_CONFIG.checksum (see the model's own field comment).
const COMPILED_CONFIG_CHECKSUM = COMPILED_CONFIG.checksum;

// Real `validate()` output, scoped to WF-SUMM-* only — see the module docstring.
const VALIDATION_REPORT = {
  reportVersion: 1,
  ok: true,
  findings: [],
  ruleSetVersion: 1,
  registryChecksum: REGISTRY_CHECKSUM,
  evaluatedAt: COMPILED_AT,
};

export const seedWorkflowDefinition = async (client: CorePrismaClient): Promise<{ success: true; created: boolean }> => {
  console.log('Seeding platform-default Summarization WorkflowDefinition (TASK-720)...');

  const existing = await client.workflowDefinition.findUnique({ where: { id: PLATFORM_DEFAULT_ID }, select: { id: true } });
  if (existing) {
    // CREATE-ONLY — a published WorkflowDefinition row is hard-immutable by house convention
    // (TASK-715 §3.4); a re-seed must never attempt to overwrite one.
    console.log('  platform-default-summarization already exists, skipping');
    return { success: true, created: false };
  }

  await client.workflowDefinition.create({
    data: {
      id: PLATFORM_DEFAULT_ID,
      tenantId: SYSTEM_TENANT_ID,
      slug: SLUG,
      name: 'Platform Default — Summarization',
      description: 'Seeded fallback the dispatcher resolves when a tenant has authored no Summarization workflow of its own (TASK-720).',
      paletteKey: 'summarization',
      versionNumber: 1,
      parentVersionId: null,
      status: 'PUBLISHED',
      graph: GRAPH,
      graphChecksum: GRAPH_CHECKSUM,
      compiledConfig: COMPILED_CONFIG,
      compiledConfigChecksum: COMPILED_CONFIG_CHECKSUM,
      registryChecksum: REGISTRY_CHECKSUM,
      validationReport: VALIDATION_REPORT,
      needsReview: false,
      validatedAt: COMPILED_AT,
      publishedAt: COMPILED_AT,
      isActive: true,
      tags: ['platform-default', 'summarization'],
      createdBy: SYSTEM_USER_ID,
    },
  });

  console.log('  created platform-default-summarization (SYSTEM tenant, PUBLISHED, isActive)');
  return { success: true, created: true };
};
