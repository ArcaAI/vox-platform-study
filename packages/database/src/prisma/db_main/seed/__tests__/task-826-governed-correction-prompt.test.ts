/**
 * TASK-826 — the durable corrector's prompt, as CONFIGURATION rather than a Python literal.
 *
 * `consultation.proposeCorrections` ran on `_CORRECTION_SYSTEM_PROMPT`, a module-level constant in
 * `apps/harness/.../consultation_realtime.py`, while the realtime caller of the SAME engine
 * already resolved a governed, APPROVED, tenant-overridable `PromptTemplate` and threw when it
 * could not. Two configuration postures for one capability, and the older one violated
 * `00-project-context.md` §Configuration Principles: *"a ... prompt ... is NOT a literal in code"*.
 *
 * ## What this file asserts, and why each half is here
 *
 * The Python half of the fix — resolve APPROVED, never default — is specified in
 * `test_realtime_capability_nodes.py::TestCorrectionInstructionIsGoverned`. What that suite CANNOT
 * assert is that the platform default actually exists, sits in the right tenancy tier, and is
 * bound on the node: a governed resolver with nothing seeded to resolve degrades on every run,
 * which is the "runs for nobody" failure TASK-815 §14a names and TASK-821 §17e closed for
 * `agent.grammar`. So this file asserts the CONFIGURATION, and that suite asserts the RUNTIME.
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

const templateRow = () => DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM)!;

describe('the platform-default note-correction instruction is a SYSTEM row', () => {
  it('is seeded, SYSTEM-tenant and approved', () => {
    const row = templateRow();
    expect(row, 'the note-correction instruction is not seeded').toBeDefined();
    expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
    // Not the "Global" CUSTOMER tenant (`SEED_TENANT_ID`, `50000000-…`). Stated as its own
    // assertion rather than implied by the one
    // above, because "the platform default lives under a customer" is the specific mistake the
    // SYSTEM tier exists to prevent, and a future edit that moved it there would otherwise fail
    // with a message about a UUID rather than about what went wrong.
    expect(row.tenantId).not.toBe(SEED_TENANT_ID);
    expect(row.approvedVersionNumber).toBe(1);
    // The row carries no `status` of its own, and must not: `seedPromptTemplate` DERIVES it with
    // `resolvePromptStatus(category)`, which publishes everything except `DNA_ANALYSIS`. That
    // derivation is load-bearing — the resolver refuses a template that is not APPROVED — so the
    // category is the thing worth pinning.
    expect(row.category).toBe('SYSTEM');
  });

  it('its version row follows the template into the SYSTEM tenant', () => {
    const version = DEFAULT_PROMPT_VERSIONS.find((v) => v.promptTemplateId === TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM)!;
    expect(version, 'the instruction has no version row').toBeDefined();
    // A version row in a different tenant from its template is unresolvable for everyone.
    expect(version.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(version.versionNumber).toBe(1);
    expect(version.content).toBe(templateRow().content);
  });

  it('speaks the verifier’s wire contract and nothing clinical', () => {
    const content = templateRow().content;
    // The three categories are the CLOSED wire vocabulary `_verified_proposals` enforces — a
    // proposal in any other category is dropped, so the instruction has to name them. That is a
    // protocol, not a clinical taxonomy the platform is inventing on a tenant's behalf.
    for (const category of ['spelling', 'medicalTerm', 'drugName']) expect(content).toContain(category);
    // The patient-safety half: this pass proposes, and must never be told it may apply.
    expect(content.toLowerCase()).toContain('never apply');
    expect(content.toLowerCase()).toContain('dose');
  });

  it('is a DISTINCT body from the live-transcript instruction, because the material differs', () => {
    const live = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM)!.content;
    const note = templateRow().content;
    expect(note).not.toBe(live);
    // The live pass reviews a PARTIAL transcript that grows between turns, so it is told not to
    // correct a word that is merely cut off. The durable pass reviews a FINISHED note, where that
    // same caveat would suppress a genuine error at the end of the note.
    expect(live).toContain('partial');
    expect(note).not.toContain('partial');
  });
});

describe('the durable corrector is BOUND to it in both seeded graphs', () => {
  it.each(GRAPHS)('%s: n_correct binds the platform-default instruction', (_label, graph) => {
    const node = nodeOf(graph, 'n_correct');
    expect(node.type).toBe('consultation.proposeCorrections');
    // Without this binding the node resolves nothing and degrades on every run — a governed
    // resolver plus an unseeded binding is the same "runs for nobody" as a hardcoded prompt,
    // only quieter.
    expect(node.config.promptTemplateId).toBe(TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM);
  });

  it.each(COMPILED)('%s: the binding survives into the COMMITTED compiled config', (_label, compiled) => {
    const node = compiledNodes(compiled).find((n: any) => n.type === 'consultation.proposeCorrections');
    expect(node, 'the corrector is absent from the compiled config').toBeDefined();
    // The authored graph is not what runs; the compiled blob is. A binding present in one and
    // absent from the other means the seed was not regenerated.
    expect(node.config.promptTemplateId).toBe(TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM);
  });
});
