/**
 * W2's suggestion prompt, as CONFIGURATION rather than a Python literal.
 *
 * `consultation.suggestions` ran on `_SUGGESTION_SYSTEM_PROMPT`, a module-level constant in
 * `apps/harness/.../consultation_realtime.py`. It is the identical defect fixed one node
 * over in the SAME file, and it violates the same rule: `00-project-context.md`
 * Principles, *"a ... prompt ... is NOT a literal in code"*.
 *
 * ## What this file asserts, and why each half is here
 *
 * The Python half — resolve APPROVED, never default — is specified in
 * `test_realtime_capability_nodes.py::TestSuggestionInstructionIsGoverned`. What that suite CANNOT
 * assert is that the platform default actually exists, sits in the right tenancy tier, and is
 * bound on the node: a governed resolver with nothing seeded to resolve degrades on every run,
 * which is the "runs for nobody" failure names. So this file asserts the
 * CONFIGURATION, and that suite asserts the RUNTIME.
 *
 * ## Why the tenancy assertion is the load-bearing one
 *
 * `PromptTemplate`/`PromptVersion` are `SYSTEM_SHARED_READ_MODELS`, so a SYSTEM-tenant row is the
 * platform tier every tenant inherits when it has no opinion. The "Global" tenant
 * (`50000000-…`) is a CUSTOMER tenant — seeding the default there would make one customer's
 * configuration the platform default for everyone else, the cross-tenant leak
 * `00-project-context.md` names explicitly.
 */
import { describe, expect, it } from 'vitest';

import { ARCAAI_CONSULTATION_GRAPH, ARCAAI_RHEUM_CONSULTATION_GRAPH } from '../23-arcaai-workflow-authoring';
import { GEN_COMPILED_CONFIG, RHEUM_COMPILED_CONFIG } from '../23-arcaai-workflow-authoring.generated';
import { DEFAULT_PROMPT_TEMPLATES, DEFAULT_PROMPT_VERSIONS, TEMPLATE_IDS } from '../07-prompt-template';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

/* eslint-disable @typescript-eslint/no-explicit-any */
const GRAPHS: Array<[string, any]> = [
  ['general medicine', ARCAAI_CONSULTATION_GRAPH],
  ['rheumatology', ARCAAI_RHEUM_CONSULTATION_GRAPH],
];
const COMPILED: Array<[string, any]> = [
  ['general medicine', GEN_COMPILED_CONFIG],
  ['rheumatology', RHEUM_COMPILED_CONFIG],
];

const nodeOf = (graph: any, id: string) => graph.nodes.find((n: any) => n.id === id);
const compiledNodes = (compiled: any) => (compiled?.stages ?? []).flatMap((stage: any) => stage.nodes ?? []);

const templateRow = () => DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM)!;

describe('the platform-default suggestion instruction is a SYSTEM row', () => {
  it('is seeded, SYSTEM-tenant and approved', () => {
    const row = templateRow();
    expect(row, 'the suggestion instruction is not seeded').toBeDefined();
    expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
    // Not the "Global" CUSTOMER tenant (`SEED_TENANT_ID`, `50000000-…`). Stated as its own
    // assertion rather than implied by the one above, because "the platform default lives under a
    // customer" is the specific mistake the SYSTEM tier exists to prevent, and a future edit that
    // moved it there would otherwise fail with a message about a UUID rather than about what went
    // wrong.
    expect(row.tenantId).not.toBe(SEED_TENANT_ID);
    expect(row.approvedVersionNumber).toBe(1);
    // The row carries no `status` of its own, and must not: `seedPromptTemplate` DERIVES it with
    // `resolvePromptStatus(category)`. That derivation is load-bearing — the resolver refuses a
    // template that is not APPROVED — so the category is the thing worth pinning.
    expect(row.category).toBe('SYSTEM');
  });

  it('its version row follows the template into the SYSTEM tenant', () => {
    const version = DEFAULT_PROMPT_VERSIONS.find((v) => v.promptTemplateId === TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM)!;
    expect(version, 'the instruction has no version row').toBeDefined();
    // A version row in a different tenant from its template is unresolvable for everyone.
    expect(version.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(version.versionNumber).toBe(1);
    expect(version.content).toBe(templateRow().content);
  });

  it('the append-only tail held: the row is LAST, so no earlier version id was renumbered', () => {
    // `DEFAULT_PROMPT_VERSIONS` derives each version id from the template's ARRAY INDEX
    // (`V${i + 1}`). Inserting this row anywhere but the end would silently re-point every later
    // template's version row at an id that already exists in deployed databases. This pins the
    // invariant rather than the comment that states it.
    const index = DEFAULT_PROMPT_TEMPLATES.findIndex((t) => t.id === TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM);
    expect(index).toBe(DEFAULT_PROMPT_TEMPLATES.length - 1);
    // Every template's version row must still line up with its own template, index for index.
    for (const [i, template] of DEFAULT_PROMPT_TEMPLATES.entries()) {
      expect(DEFAULT_PROMPT_VERSIONS[i]!.promptTemplateId, `version row ${i} drifted off its template`).toBe(template.id);
    }
    // Version ids are unique — the failure a renumbering would produce.
    const ids = DEFAULT_PROMPT_VERSIONS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('speaks the node’s wire contract and its two safety bars', () => {
    const content = templateRow().content;
    // The wire shape `_parse_json_object` reads back.
    expect(content).toContain('suggestions');
    expect(content).toContain('category');
    // PROPOSE, never assert — these are read by a clinician mid-consultation.
    expect(content.toLowerCase()).toContain('never assert');
    expect(content.toLowerCase()).toContain('never invent');
    // A model told only to produce suggestions produces them from nothing on a quiet transcript.
    expect(content).toContain('{"suggestions":[]}');
  });

  it('is a DISTINCT body from both correction instructions, because the task is the opposite', () => {
    const note = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM)!.content;
    const live = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM)!.content;
    const suggest = templateRow().content;
    expect(suggest).not.toBe(note);
    expect(suggest).not.toBe(live);
    // The two correction bodies REVIEW existing words and may add nothing. This one's entire
    // purpose is to raise what is ABSENT, so a shared body would be wrong for one of them.
    expect(note).toContain('never apply');
    expect(suggest).not.toContain('never apply');
    expect(suggest).toContain('omissions');
  });
});

describe('the suggestion node is BOUND to it in both seeded graphs', () => {
  it.each(GRAPHS)('%s: n_suggest binds the platform-default instruction', (_label, graph) => {
    const node = nodeOf(graph, 'n_suggest');
    expect(node.type).toBe('consultation.suggestions');
    // Without this binding the node resolves nothing and degrades on every run — a governed
    // resolver plus an unseeded binding is the same "runs for nobody" as a hardcoded prompt,
    // only quieter.
    expect(node.config.promptTemplateId).toBe(TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM);
  });

  it.each(COMPILED)('%s: the binding survives into the COMMITTED compiled config', (_label, compiled) => {
    const node = compiledNodes(compiled).find((n: any) => n.type === 'consultation.suggestions');
    expect(node, 'the suggestion node is absent from the compiled config').toBeDefined();
    // The authored graph is not what runs; the compiled blob is. A binding present in one and
    // absent from the other means the seed was not regenerated.
    expect(node.config.promptTemplateId).toBe(TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM);
  });
});
