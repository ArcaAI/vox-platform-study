/**
 * TASK-932 D-9 — the WARM-START agent, `case-notes-pre-summary`.
 *
 * The owner's journey opens with "previous case notes → pre-summary while recording starts". Until
 * this ticket the pre-summary was reachable only through the legacy `POST :id/pre-summary` route
 * and the tenant tag-convention prompt tier — the consultation GRAPH said nothing about it, so the
 * one step the clinician sees first was the one step no workflow governed.
 *
 * This file pins the three facts that make it a graph step instead:
 *
 *  1. the agent exists in all three tenants that seed content (Global authors, SYSTEM is the
 *     promoted copy, ArcaAI carries its own bound to the v3 corpus);
 *  2. every `{{context.*}}` its body reads is DECLARED by `consultation_note_context`, so the
 *     bindings resolve on the seeded graphs by construction rather than by luck;
 *  3. the two bodies — the SYSTEM platform default (…040) and the ArcaAI v3 corpus — read exactly
 *     the same nine names, which is what lets ONE binding set serve both.
 *
 * Fact 3 is the one that would rot silently: the two bodies live in different files, were written
 * years apart, and nothing else compares them.
 */
import { describe, expect, it } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';
import { ARCAAI_CLINICAL_APPROVED_VERSION, ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_TEMPLATE_IDS } from '../07b-arcaai-clinical-templates';
import { NOTE_CONTEXT_SCHEMA_DEFINITION } from '../07e-consultation-note-context-schema';
import {
  GLOBAL_AGENT_ASSIGNMENTS,
  GLOBAL_AGENT_SPECS,
  PLATFORM_AGENT_ASSIGNMENTS,
  PLATFORM_AGENT_SPECS,
  PRE_SUMMARY_AGENT_SLUG,
  PRE_SUMMARY_PARAMETERS,
  PRE_SUMMARY_VARIABLE_NAMES,
  preSummaryPromptVariables,
} from '../25-agents';
import { ARCAAI_PRE_SUMMARY_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';

/** Every `{{context.<name>}}` a body reads, deduplicated. */
function contextPlaceholders(body: string): Set<string> {
  return new Set([...body.matchAll(/\{\{\s*context\.([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]!));
}

const contextFields = new Set(
  Object.keys(
    (NOTE_CONTEXT_SCHEMA_DEFINITION as unknown as { kinds: Array<{ key: string; fields?: { properties: Record<string, unknown> } }> }).kinds.find(
      (kind) => kind.key === 'context',
    )!.fields!.properties,
  ),
);

const systemPreSummaryBody = String(DEFAULT_PROMPT_TEMPLATES.find((template) => template.id === TEMPLATE_IDS.PRE_SUMMARY_DEFAULT)!.content);
const arcaaiPreSummaryBody = String(ARCAAI_CLINICAL_TEMPLATES.find((template) => template.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY)!.content);

describe('TASK-932 D-9 — the `case-notes-pre-summary` warm-start agent', () => {
  it('Global authors it and SYSTEM carries the promoted copy, both PUBLISHED and bound to the platform pre-summary template', () => {
    for (const [specs, tenantId] of [
      [GLOBAL_AGENT_SPECS, SEED_TENANT_ID],
      [PLATFORM_AGENT_SPECS, SYSTEM_TENANT_ID],
    ] as const) {
      const spec = specs.find((candidate) => candidate.slug === PRE_SUMMARY_AGENT_SLUG);
      expect(spec, `${tenantId} has no ${PRE_SUMMARY_AGENT_SLUG}`).toBeDefined();
      expect(spec).toMatchObject({
        tenantId,
        task: 'TEXT_GENERATION',
        modelSlug: 'lms-gemma-4-e2b-it-qat',
        status: 'PUBLISHED',
        isActive: true,
        parameters: PRE_SUMMARY_PARAMETERS,
      });
      // …040 is SYSTEM-owned and in `SYSTEM_SHARED_READ_MODELS`, which is precisely what
      // `07-prompt-template.ts` records as the reason it was re-owned to SYSTEM: a Global-owned
      // row "was invisible to every other tenant". Binding both authoring tiers to it is therefore
      // a read the platform already sanctions — and phase 26 re-points a CLONED agent at the
      // tenant's own copy (`copyAgents`), so a provisioned tenant never reads across the boundary.
      expect((spec!.instruction as { promptTemplateId: string }).promptTemplateId).toBe(TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
      expect((spec!.instruction as { promptVersionNumber: number }).promptVersionNumber).toBe(1);
      expect(spec!.tags).toContain('phase:pre-summary');
    }
  });

  it('ArcaAI carries its OWN copy of the same lineage key, bound to the department corpus at the approved version', () => {
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC).toMatchObject({
      tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
      slug: PRE_SUMMARY_AGENT_SLUG,
      task: 'TEXT_GENERATION',
      status: 'PUBLISHED',
      isActive: true,
      parameters: PRE_SUMMARY_PARAMETERS,
    });
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC.instruction).toMatchObject({
      promptTemplateId: ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
      promptVersionNumber: ARCAAI_CLINICAL_APPROVED_VERSION,
    });
    // Same slug as the platform row, DIFFERENT tenant: `copyAgents` skips a slug the tenant
    // already has, and phase 29 runs before phase 26, so ArcaAI's own body wins and the SYSTEM
    // copy is simply never made. That is the "content is cloned" rule producing one row, not two.
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC.provenance).toBeNull();
  });

  it('the two pre-summary bodies read exactly the same nine `{{context.*}}` names', () => {
    const platform = [...contextPlaceholders(systemPreSummaryBody)].sort();
    const corpus = [...contextPlaceholders(arcaaiPreSummaryBody)].sort();
    expect(platform).toEqual(corpus);
    expect(platform).toEqual([...PRE_SUMMARY_VARIABLE_NAMES].sort());
    expect(PRE_SUMMARY_VARIABLE_NAMES).toHaveLength(9);
  });

  it('every declared name is a field of `consultation_note_context`, bound to its `trigger.context.*` path', () => {
    const bindings = preSummaryPromptVariables();
    expect(Object.keys(bindings).sort()).toEqual([...PRE_SUMMARY_VARIABLE_NAMES].sort());
    for (const name of PRE_SUMMARY_VARIABLE_NAMES) {
      expect(bindings[name]).toEqual({ path: `trigger.context.${name}` });
      expect(contextFields.has(name), `the trigger schema declares no \`${name}\``).toBe(true);
    }
  });

  it('all three seeded copies bind the same nine variables — one binding set, three bodies', () => {
    const expected = preSummaryPromptVariables();
    for (const spec of [
      GLOBAL_AGENT_SPECS.find((candidate) => candidate.slug === PRE_SUMMARY_AGENT_SLUG)!,
      PLATFORM_AGENT_SPECS.find((candidate) => candidate.slug === PRE_SUMMARY_AGENT_SLUG)!,
      ARCAAI_PRE_SUMMARY_AGENT_SPEC,
    ]) {
      expect((spec.instruction as { variables: unknown }).variables).toEqual(expected);
    }
  });

  it('the warm start keeps reasoning OFF and guards ON, and asks for more completion than a per-turn note', () => {
    expect(PRE_SUMMARY_PARAMETERS.generation.reasoning).toEqual({ enabled: false });
    expect(PRE_SUMMARY_PARAMETERS.guards).toEqual({ enabled: true });
    expect(PRE_SUMMARY_PARAMETERS.generation.maxTokens).toBeGreaterThan(2048);
  });

  it('is assigned at TENANT scope under `phase:pre-summary` in both authoring tenants', () => {
    for (const assignments of [PLATFORM_AGENT_ASSIGNMENTS, GLOBAL_AGENT_ASSIGNMENTS]) {
      const row = assignments.find((candidate) => candidate.agentSlug === PRE_SUMMARY_AGENT_SLUG);
      expect(row).toMatchObject({ task: 'TEXT_GENERATION', selectorKey: 'phase:pre-summary' });
    }
  });
});
