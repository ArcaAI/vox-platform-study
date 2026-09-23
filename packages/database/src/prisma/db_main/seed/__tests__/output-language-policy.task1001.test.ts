/**
 * TASK-1001 Phase 3 (OD-1 / OD-3 / OD-8) — the seeded output-language policy, and how the 22
 * ArcaAI department summary agents reference it.
 *
 * The applications-side twin of this file
 * (`live-documentation.operating-frame.task1001.test.ts`) proves the policy reaches the RENDERED
 * prompt, that `operatingFrame` states no language of its own while the policy is selected, and
 * that it states the platform default (English) when it is not. This one proves the SEED says what
 * that render needs it to say — the two halves are in different packages and neither can see the
 * other, so the S-4 clause and the named override are pinned on both sides on purpose.
 *
 * **Finding S-4, restated because it is the reason this file exists.** ALaaS merges a live section
 * onto a held one by exact `documentKey::sectionKey`, or by title SLUG when one identity is
 * generic. A translated or reworded heading is a different section to that reducer: it inserts a
 * twin, and `orderSections` dedupes on key only, so nothing removes it. The clause *"Keep the
 * section keys and headings exactly as given, in English."* rode along with the language line this
 * ticket retired out of code. If it stops riding along with the policy that replaced it, every
 * section in the client duplicates.
 */
import { describe, expect, it } from 'vitest';
import { OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY } from '@arcaai/types';

import {
  ARCAAI_CLINICAL_APPROVED_VERSION,
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_TEMPLATE_IDS,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
  arcaaiOutputLanguagePolicyFragment,
} from '../07b-arcaai-clinical-templates';
import { ARCAAI_DEPARTMENT_AGENT_SPECS, ARCAAI_PRE_SUMMARY_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';

/** Verbatim. The whole point of S-4 is that these bytes survive. */
const HEADINGS_CLAUSE = 'Keep the section keys and headings exactly as given, in English.';

/**
 * TASK-1001 (owner decision 2026-09-23) — the conflict the policy overrides, NAMED. The clinical
 * corpus says "the section content MUST be in the conversation language" in ~40 places, and a
 * generic label loses to that specific in-template instruction (the 2026-08-10 lesson). The
 * runtime's own platform-default step names the same conflict in the same words.
 */
const OVERRIDE_CLAUSE = 'regardless of any instruction elsewhere in this prompt to write content in the conversation language';

/** `AGENT_PROMPT_FRAGMENT_KEY_PATTERN` of @arcaai/workflow-contract (this package takes no dependency on it). */
const FRAGMENT_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

interface Fragment {
  key: string;
  promptTemplateId?: string;
  promptVersionNumber?: number;
  systemPrompt?: string;
  when?: string;
}

const fragmentsOf = (spec: { instruction: Record<string, unknown> | null }): Fragment[] => {
  const fragments = spec.instruction?.fragments;
  expect(Array.isArray(fragments), 'the agent is not on the composite instruction form').toBe(true);
  return fragments as Fragment[];
};

describe('the policy TEMPLATE', () => {
  it('carries the S-4 headings clause, verbatim (REGRESSION PIN)', () => {
    expect(
      ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT,
      'without this clause a translated heading makes ALaaS insert a twin section that nothing ever removes',
    ).toContain(HEADINGS_CLAUSE);
  });

  it('states an output language — the half a tenant admin actually edits', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).toMatch(/Write every section value in English/);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).toMatch(/whatever language was spoken/);
  });

  it('NAMES the conflict it overrides — the corpus`s own "write in the conversation language" clause', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).toContain(OVERRIDE_CLAUSE);
    // In the SAME sentence as the language, so the override cannot be read as a separate rule.
    const languageSentence = ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT.split('\n').find((line) => line.startsWith('Write every section value in'));
    expect(languageSentence).toContain(OVERRIDE_CLAUSE);
  });

  it('does not promise what the runtime does not do: publish freezes the text, so a republish is required', () => {
    // The row's description is what a tenant admin reads in the console. It used to say "edit THIS
    // row to change the output language for the whole tenant", which is false at runtime: each
    // agent serves the copy frozen into its `compiledConfig` at publish.
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.description).not.toMatch(/edit THIS row/i);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.description).toMatch(/republish/i);
  });

  it('names no diagnostic code system (INV-065/066) — it is outside the corpus`s own containment sweep', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).not.toMatch(/ICD-?10/i);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.description).not.toMatch(/ICD-?10/i);
  });

  it('is APPROVED and pinned at a version that is actually seeded — an unpinned APPROVED row resolves to nothing', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.status).toBe('APPROVED');
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.approvedVersionNumber).toBe(1);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.currentVersionNumber).toBe(1);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION.versionNumber).toBe(1);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION.promptTemplateId).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION.content).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT);
  });

  it('is tenant-wide with no department axis — one row for all 11 departments and both visit types', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.scope).toBe('TENANT_DEFAULT');
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.departmentId).toBeNull();
  });

  it('is NOT tagged `pre-summary` — that tag is how the tenant pre-summary row is found, and a second match makes the winner an ordering accident', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.tags).not.toContain('pre-summary');
  });

  it('stays OUT of the clinical corpus, whose tests count 22 + 1 and require v1/v2/v3 on every row', () => {
    expect(Object.values(ARCAAI_CLINICAL_TEMPLATE_IDS)).not.toContain(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(ARCAAI_CLINICAL_TEMPLATES.map((template) => template.id)).not.toContain(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(ARCAAI_CLINICAL_VERSIONS.map((version) => version.promptTemplateId)).not.toContain(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
  });

  it('does not collide with a clinical template id or version id', () => {
    const ids = new Set(ARCAAI_CLINICAL_TEMPLATES.map((template) => template.id));
    const versionIds = new Set(ARCAAI_CLINICAL_VERSIONS.map((version) => version.id));
    expect(ids.has(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID)).toBe(false);
    expect(versionIds.has(ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION.id)).toBe(false);
  });
});

describe('the FRAGMENT every department summary agent attaches', () => {
  it('is a POINTER, never an inlined body — 22 copies of a policy is 22 places to edit it', () => {
    const fragment = arcaaiOutputLanguagePolicyFragment();
    expect(fragment.promptTemplateId).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect((fragment as { systemPrompt?: string }).systemPrompt).toBeUndefined();
  });

  it('pins NO version — a pin would freeze all 22 agents on today`s body and forfeit the single-point edit', () => {
    expect(arcaaiOutputLanguagePolicyFragment()).not.toHaveProperty('promptVersionNumber');
  });

  it('is UNCONDITIONAL — the conditional translate-to-X sibling is deliberately not seeded (the CEL scope path is unverified)', () => {
    expect(arcaaiOutputLanguagePolicyFragment()).not.toHaveProperty('when');
  });

  it('has a key the publish gate accepts', () => {
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY).toMatch(FRAGMENT_KEY_PATTERN);
  });

  it('uses the PLATFORM-RESERVED key the runtime asks about — one spelling, declared in @arcaai/types', () => {
    // The live lane decides "does the tenant's policy own the language?" by looking for a SELECTED
    // fragment under exactly this key. A seed-local spelling would attach a policy the runtime never
    // recognises, and the platform default would then be stated beside it.
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY).toBe(OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY);
    expect(OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY).toBe('output_language_policy');
    expect(arcaaiOutputLanguagePolicyFragment().key).toBe(OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY);
  });
});

describe('the 22 department summary agents', () => {
  it('each compose exactly two fragments: the department body, then the policy', () => {
    expect(ARCAAI_DEPARTMENT_AGENT_SPECS).toHaveLength(22);

    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      const fragments = fragmentsOf(spec);
      expect(fragments, spec.slug).toHaveLength(2);
      // ORDER: the policy is LAST, nearest the generation point, which is where a model honours
      // an instruction most reliably — and winning is this fragment's entire job.
      expect(fragments[1]!.key, spec.slug).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY);
      expect(fragments[1]!.promptTemplateId, spec.slug).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    }
  });

  it('keep the department body AND its corpus pin — a composite replaces `promptTemplateId`, so a slip loses the clinical instruction entirely', () => {
    const clinicalIds = new Set<string>(Object.values(ARCAAI_CLINICAL_TEMPLATE_IDS));

    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      const clinical = fragmentsOf(spec)[0]!;
      expect(clinicalIds.has(clinical.promptTemplateId ?? ''), `${spec.slug} lost its department template`).toBe(true);
      // The agent's pin outranks the template's `approvedVersionNumber`, which is what makes
      // `ARCAAI_CLINICAL_APPROVED_VERSION` a one-constant corpus rollback. Unchanged by this ticket.
      expect(clinical.promptVersionNumber, spec.slug).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);
    }
  });

  it('carry no leftover top-level binding — the three instruction forms are mutually exclusive', () => {
    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      expect(spec.instruction, spec.slug).not.toHaveProperty('promptTemplateId');
      expect(spec.instruction, spec.slug).not.toHaveProperty('systemPrompt');
      // `instruction.promptVersionNumber` is a publish ERROR on a composite: the pin belongs on
      // the fragment that binds the template.
      expect(spec.instruction, spec.slug).not.toHaveProperty('promptVersionNumber');
    }
  });

  it('use valid, unique fragment keys and supply a BASE fragment (publish refuses a list with none)', () => {
    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      const fragments = fragmentsOf(spec);
      const keys = fragments.map((fragment) => fragment.key);
      for (const key of keys) expect(key, spec.slug).toMatch(FRAGMENT_KEY_PATTERN);
      expect(new Set(keys).size, `${spec.slug} has duplicate fragment keys`).toBe(keys.length);
      expect(
        fragments.some((fragment) => fragment.when === undefined),
        `${spec.slug} has no unconditional fragment`,
      ).toBe(true);
    }
  });

  it('all reference the SAME policy row — that is what makes it one edit for the whole tenant', () => {
    const referenced = new Set(ARCAAI_DEPARTMENT_AGENT_SPECS.map((spec) => fragmentsOf(spec)[1]!.promptTemplateId));
    expect(referenced.size).toBe(1);
  });
});

describe('what this ticket deliberately did NOT change', () => {
  it('the warm-start pre-summary agent keeps its single template binding', () => {
    // Its body already carries `{language_name}` and is tenant-editable through the template
    // itself (the lane A3 compared favourably against), so a policy fragment here would state the
    // same rule in a second place — which is the thing this ticket is removing, not adding.
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC.instruction).toHaveProperty('promptTemplateId', ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC.instruction).not.toHaveProperty('fragments');
  });
});
