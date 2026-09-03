import type { CorePrismaClient } from '../../../client';
import { SEED_WORKFLOW_DEFINITION_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * WorkflowDefinition Seed — the platform-default Summarization definition.
 *
 * ONE new row is new here — no deployed row exists to drift, unlike `PromptTemplate`
 * (assessment, cited by rule 02 §Seeds: "Deployed rows do not re-seed and have
 * drifted — this needs a data migration, not just a seed edit"). A seed alone is therefore
 * correct THIS TIME. Say so explicitly so a later reader does not assume the general case:
 * once this row exists in any deployed environment, a further shape change to `graph` /
 * `compiledConfig` needs a data migration, not an edit to this file (the same rule that makes
 * `PromptTemplate` care).
 *
 * This is the row `design.md` flow / handling describes: "the dispatcher resolves
 * the tenant's active published version — or the platform default config" / "Temporal
 * unreachable → platform default config". SYSTEM-tenant, `status: PUBLISHED`, `isActive: true`.
 *
 * ## Honesty note on `graph` / `compiledConfig` / `validationReport` (read before editing)
 *
 * `graph` and `compiledConfig` below are NOT hand-typed JSON — they are the literal output of
 * `packages/workflow-contract`'s real `validate()`/`compile()` engine, run against
 * this exact node set via a throwaway script and pasted here verbatim. This keeps the seed
 * provably byte-consistent with the one compiler implementation rather than a second,
 * hand-maintained copy of its output shape. `packages/database` deliberately does NOT take a
 * runtime dependency on `@arcaai/workflow-contract` for this (`packages/database/package.json`
 * is unmodified) — adding one would touch the shared root `pnpm-lock.yaml` while sibling
 * xx agents share this working tree, which is exactly the collision surface the
 * orchestrator's hard rules ask every ticket to avoid. If the graph ever needs to change,
 * regenerate both blobs from `compile()`/`validate()` again rather than hand-editing the JSON.
 *
 * `activity` strings inside `compiledConfig.stages[].nodes[]` are byte-identical to the
 * Temporal-registered names in 's
 * node table — a mismatch there is exactly what makes the interpreter's S-4 dispatch check
 * `SKIPPED(reason="activity_mismatch")` every node (see that doc + `execution-semantics.md`
 *
 * `registryChecksum` / `compiledConfig` — regenerate with
 * `scripts/regen-workflow-definition-seed.ts`, never by hand. last re-ran it,
 * because this graph's EDGES changed: they were migrated off the untyped `fromPort:'out'` /
 * `toPort:'in'` convention onto the node contract's named, typed sockets (see the comment above
 * `GRAPH.edges`). A regeneration cannot half-apply, so that same run also closed the three drifts
 * recorded here — a checksum computed over the seven-entry registry of the time,
 * `compilerVersion: 'task-720-seed-1'`, and `caps.maxNodeSeconds: 900` — every one of which
 * differed from what a real publish through `WorkflowDefinitionService` stamps, which is to say
 * this row could not have been reproduced by republishing it. The script itself had a fourth
 * defect that made the drift unclearable: it omitted `compiledAt`, so `compile()` hashed a
 * wall-clock value into `checksum` while the printed config carried the pinned constant. It now
 * pins `compiledAt`, and its drift verdict reads 0.
 *
 * `validationReport` is real — it is `validate()`'s actual output — but it is SCOPED to only
 * the `WF-SUMM-*` structural rules added (`packages/workflow-contract/src/rule-catalogue.ts`),
 * not the full `DRAFT_SUMMARIZATION_RULE_SET`. Running the full catalogue against this graph
 * today produces ERROR findings from the pre-existing, palette-independent `WF-S-002/003/004/007`
 * rules, which assume literal `core.start`/`core.end` node types this palette does not use (see
 * `contracts/palette.md`'s "Mandatory-subgraph rule set" section for the full explanation) — a
 * rule-design gap, not something fixes. Claiming a clean report against
 * rules that cannot structurally pass for this palette would be dishonest, so this row's report
 * says exactly what it checked and nothing more. There is also no real `WorkflowValidatorService`
 * (gated on the same missing registry) to have produced a *server-side*
 * certification — this is the compiler engine's own pure verdict on the graph it compiled, which
 * is the most that can honestly be claimed in this session.
 */

// Exported so `scripts/regen-workflow-definition-seed.ts` can recompute the blobs
// below from the REAL `compile()`/`validate()` instead of anyone hand-editing the JSON. These are
// the regeneration INPUTS; everything derived from them is generated output.
export const PLATFORM_DEFAULT_ID = SEED_WORKFLOW_DEFINITION_IDS.PLATFORM_DEFAULT_SUMMARIZATION;
export const SLUG = 'platform-default-summarization';
export const COMPILED_AT = '2026-08-16T00:00:00.000Z';
// Real `registryChecksum()` output over the CURRENT `WORKFLOW_NODE_REGISTRY` (48 entries),
// regenerated by `scripts/regen-workflow-definition-seed.ts` — never hand-typed.
// re-ran that script because the GRAPH's edges changed (named sockets), and a regeneration cannot
// half-apply: the same run also closed the three drifts recorded against this row
// (a checksum over the seven-entry registry of the time, `compilerVersion: 'task-720-seed-1'`,
// and `caps.maxNodeSeconds: 900`), all of which differed from what a real publish through
// `WorkflowDefinitionService` stamps. The script's own drift verdict is now clean.
//
// Re-run 2026-08-29: the registry gained the TARGET CATALOGUE's nine `agent.*`
// node types and DD-7's three `guard.*` types, and `registryChecksum()` hashes every descriptor
// INCLUDING its `configSchema` — which also moved, because item 5 folded the palette-agnostic
// `timeoutSeconds`/`retry` knobs `compileNode` already reads into every schema. This row's own
// GRAPH is unchanged; only the checksum it stamps is. It was ALSO stale before that re-run
// (it still carried the value from the OD-15 regeneration, while three endpoint node
// types had moved the registry since) — the kind of drift this script exists to make visible.
const REGISTRY_CHECKSUM = 'ff06c16b9ee08534845e208a5e1cfd3eea16190eed5b0bf794439f72d77a7aca';

export const GRAPH = {
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
  // migrated from the untyped `fromPort:'out'/toPort:'in'` convention to the
  // node contract's NAMED SOCKETS (`node-ports.ts`). Three of these four edges changed, and the
  // fourth is new:
  //
  //   e1 out -> `in` became out -> `context` — `generate.text` has no port called `in`;
  //                                                     it has two distinct data inputs, the bound
  //                                                     context and the resolved prompt.
  //   e2 unchanged — `document ⊑ text`, the one widening that
  //                                                     lets a guardrail read any textual product.
  //   e3 out -> `in` became out -> `verdict` — `guardrail.check` produces a VERDICT, not
  //                                                     a document. Under the old convention it
  //                                                     also happened to carry the text along in
  //                                                     its whole output object; that is exactly
  //                                                     the untyped bundle this contract abolishes.
  //   e4 NEW — so the content `output.deliver` renders
  //                                                     now arrives on a typed `document` edge from
  //                                                     the generator, instead of riding invisibly
  //                                                     inside the guardrail's output dict.
  edges: [
    { id: 'e1', from: 'n_input', fromPort: 'out', to: 'n_gen', toPort: 'context' },
    { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_guard', toPort: 'in' },
    { id: 'e3', from: 'n_guard', fromPort: 'out', to: 'n_out', toPort: 'verdict' },
    { id: 'e4', from: 'n_gen', fromPort: 'out', to: 'n_out', toPort: 'in' },
  ],
};

// Verbatim `compile()` output — see the module docstring for how this was produced.
export const COMPILED_CONFIG = {
  formatVersion: 1,
  definitionId: PLATFORM_DEFAULT_ID,
  slug: SLUG,
  versionNumber: 1,
  tenantId: SYSTEM_TENANT_ID,
  paletteKey: 'summarization',
  compiledAt: COMPILED_AT,
  compilerVersion: '0.1.0',
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
          inputs: [{ fromNodeId: 'n_input', fromPort: 'out', toPort: 'context' }],
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
          inputs: [{ fromNodeId: 'n_gen', fromPort: 'out', toPort: 'in' }, { fromNodeId: 'n_guard', fromPort: 'out', toPort: 'verdict' }],
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
    documentTemplateRefs: [],
    contextSchemaVersionId: null,
    entitlementKeys: [],
  },
  caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
  // sha256 over canonicalJson of every field above (computed by `compile()` — see docstring).
  checksum: '56806dfb587a7a55f0868477e379f80343b8362093582acb29cef6eacbc69038',
};

// sha256 over canonicalJson(GRAPH), computed by the same `canonicalJson` the compiler uses.
const GRAPH_CHECKSUM = 'de3654aa9a10610f53b54eff8b02c1b08f4419f6cb7c71c0b98a5b0bd23d2a09';
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
  console.log('Seeding platform-default Summarization WorkflowDefinition ...');

  const existing = await client.workflowDefinition.findUnique({ where: { id: PLATFORM_DEFAULT_ID }, select: { id: true } });
  if (existing) {
    // CREATE-ONLY — a published WorkflowDefinition row is hard-immutable by house convention
    // (; a re-seed must never attempt to overwrite one.
    console.log('  platform-default-summarization already exists, skipping');
    return { success: true, created: false };
  }

  await client.workflowDefinition.create({
    data: {
      id: PLATFORM_DEFAULT_ID,
      tenantId: SYSTEM_TENANT_ID,
      slug: SLUG,
      name: 'Platform Default — Summarization',
      description: 'Seeded fallback the dispatcher resolves when a tenant has authored no Summarization workflow of its own .',
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
