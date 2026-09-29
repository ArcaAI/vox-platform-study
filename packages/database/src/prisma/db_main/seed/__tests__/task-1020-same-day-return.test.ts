/**
 * TASK-1020 OD-5(a) / OD-6 — the same-day-return instruction fragment and the `investigations`
 * context kind, as SEEDED.
 *
 * The runtime halves live elsewhere: L-CARRY produces `same_day_prequel_summary`,
 * `formatted_test_results` and the `trigger.context.same_day_prequel` boolean. This file proves
 * the SEED carries what those producers feed — and, because the `when` is evaluated by the REAL
 * engine (built `@arcaai/workflow-contract`, loaded by path like `task-930-workflow-seeds`), that
 * the condition is in the grammar and behaves on the three scopes that matter.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_TEMPLATE_IDS,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
  ARCAAI_SAME_DAY_RETURN_CONTENT,
  ARCAAI_SAME_DAY_RETURN_TEMPLATE,
  ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID,
  ARCAAI_SAME_DAY_RETURN_VERSION,
} from '../07b-arcaai-clinical-templates';
import { ARCAAI_CONSULTATION_SCRIBE_DEFINITION } from '../07g-arcaai-two-schemas';
import { ARCAAI_DEPARTMENT_AGENT_SPECS } from '../29-arcaai-agents-and-workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIST = path.resolve(HERE, '../../../../../../workflow-contract/dist/index.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = await import(/* @vite-ignore */ CONTRACT_DIST);

const FRAGMENT_KEY = 'same_day_return';
const WHEN = 'has(trigger.context.same_day_prequel) && trigger.context.same_day_prequel == true';

interface Fragment {
  key: string;
  promptTemplateId?: string;
  promptVersionNumber?: number;
  when?: string;
}
const fragmentsOf = (spec: { instruction: Record<string, unknown> | null }): Fragment[] => (spec.instruction as { fragments: Fragment[] }).fragments;

const revisit = ARCAAI_DEPARTMENT_AGENT_SPECS.filter((spec) => spec.slug.endsWith('-summary-revisit'));
const newVisit = ARCAAI_DEPARTMENT_AGENT_SPECS.filter((spec) => spec.slug.endsWith('-summary-new-visit'));

describe('the same-day-return fragment on the agents', () => {
  it('splits the 22 department agents into 11 revisit and 11 new-visit', () => {
    expect(revisit).toHaveLength(11);
    expect(newVisit).toHaveLength(11);
  });

  it('every REVISIT agent composes clinical_note, then same_day_return (conditional), then the language policy LAST', () => {
    for (const spec of revisit) {
      const fragments = fragmentsOf(spec);
      expect(
        fragments.map((fragment) => fragment.key),
        spec.slug,
      ).toEqual(['clinical_note', FRAGMENT_KEY, ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY]);
      const sameDay = fragments[1]!;
      expect(sameDay.promptTemplateId, spec.slug).toBe(ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID);
      expect(sameDay.when, spec.slug).toBe(WHEN);
      // Unpinned, like the language policy: a pointer to ONE shared row.
      expect(sameDay, spec.slug).not.toHaveProperty('promptVersionNumber');
    }
  });

  it('NO new-visit agent carries it — a first visit has no earlier visit today to continue', () => {
    for (const spec of newVisit) {
      const keys = fragmentsOf(spec).map((fragment) => fragment.key);
      expect(keys, spec.slug).toEqual(['clinical_note', ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY]);
      expect(
        fragmentsOf(spec).some((fragment) => fragment.promptTemplateId === ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID),
        spec.slug,
      ).toBe(false);
    }
  });

  it('the seeded `when` is in the engine grammar, reads only a scope root, and has a key the publish gate accepts', () => {
    expect(contract.expressionProblems(WHEN)).toEqual([]);
    expect(contract.conditionRootProblems(WHEN, [])).toEqual([]);
    expect(FRAGMENT_KEY).toMatch(/^[a-z0-9_]{2,48}$/);
    // The one fragment that may be conditional is never the only one: the base is unconditional.
    for (const spec of revisit) expect(fragmentsOf(spec)[0]!.when, spec.slug).toBeUndefined();
  });

  it('the REAL selector picks it only when same_day_prequel is true — absent and false exclude it CLEANLY (no condition_error)', () => {
    const fragments = fragmentsOf(revisit[0]!);
    const select = (scope: Record<string, unknown>) => contract.selectPromptFragments(fragments, scope);

    const withPrequel = select({ trigger: { context: { same_day_prequel: true } } });
    expect(withPrequel.selected.map((fragment: Fragment) => fragment.key)).toContain(FRAGMENT_KEY);

    for (const scope of [{ trigger: { context: { same_day_prequel: false } } }, { trigger: { context: {} } }, { trigger: {} }, {}]) {
      const result = select(scope);
      expect(result.selected.map((fragment: Fragment) => fragment.key)).not.toContain(FRAGMENT_KEY);
      expect(result.excluded, JSON.stringify(scope)).toEqual([{ key: FRAGMENT_KEY, reason: 'condition_false' }]);
    }
  });
});

describe('the same-day-return TEMPLATE', () => {
  it('states the six rules and names the two placeholders in the one `{{context.*}}` grammar', () => {
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('SAME-DAY RETURN VISIT.');
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('{{context.same_day_prequel_summary');
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('{{context.formatted_test_results');
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('Investigations (Previous vs Current)');
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('DEFINITIVE plan of care');
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).toContain('Never invent a result');
    // The rest of the corpus writes single-brace names only in the retired v1 form.
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).not.toMatch(/(?<!\{)\{[a-z_]+\}(?!\})/);
  });

  it('every placeholder survives an unresolved run: each carries a default, so a missing value never 400s a publish or a call', () => {
    const placeholders = [...ARCAAI_SAME_DAY_RETURN_CONTENT.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]);
    expect(placeholders).toHaveLength(2);
    for (const placeholder of placeholders) expect(placeholder).toMatch(/\|\s*default\(/);
    expect(contract.requiredPromptVariables({ source: 'inline', content: ARCAAI_SAME_DAY_RETURN_CONTENT })).toEqual([]);
  });

  it('is APPROVED and pinned at a seeded version, tenant-wide, with no department axis and no pre-summary tag', () => {
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.status).toBe('APPROVED');
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.approvedVersionNumber).toBe(1);
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.currentVersionNumber).toBe(1);
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.scope).toBe('TENANT_DEFAULT');
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.departmentId).toBeNull();
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.category).toBe('SUMMARY');
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.tags).toContain('arcaai-same-day-return');
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.tags).not.toContain('pre-summary');
    expect(ARCAAI_SAME_DAY_RETURN_VERSION.versionNumber).toBe(1);
    expect(ARCAAI_SAME_DAY_RETURN_VERSION.promptTemplateId).toBe(ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID);
    expect(ARCAAI_SAME_DAY_RETURN_VERSION.content).toBe(ARCAAI_SAME_DAY_RETURN_CONTENT);
  });

  it('stays OUT of the clinical corpus (22 + 1, v1/v2/v3 on every row) and shares no id with it', () => {
    expect(Object.values(ARCAAI_CLINICAL_TEMPLATE_IDS)).not.toContain(ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID);
    expect(ARCAAI_CLINICAL_TEMPLATES.map((template) => template.id)).not.toContain(ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID);
    expect(ARCAAI_CLINICAL_VERSIONS.map((version) => version.promptTemplateId)).not.toContain(ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID);
    expect(ARCAAI_CLINICAL_VERSIONS.map((version) => version.id)).not.toContain(ARCAAI_SAME_DAY_RETURN_VERSION.id);
  });

  it('names no diagnostic code system (INV-065/066)', () => {
    expect(ARCAAI_SAME_DAY_RETURN_CONTENT).not.toMatch(/ICD-?10/i);
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.description).not.toMatch(/ICD-?10/i);
  });
});

describe('the `investigations` context kind on the scribe schema (OD-6)', () => {
  const kinds = ARCAAI_CONSULTATION_SCRIBE_DEFINITION.kinds as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const investigations = kinds.find((entry) => entry.key === 'investigations')!;

  it('is STRUCTURED / ONE / PRE / PHI, client-produced, right after vitals, and carries no open-time marker or materializeAs', () => {
    expect(investigations).toBeDefined();
    expect(investigations).toMatchObject({ primitive: 'STRUCTURED', cardinality: 'ONE', lifecycle: 'PRE', phiClass: 'PHI', producedBy: ['CLIENT'] });
    expect(kinds.map((entry) => entry.key).indexOf('investigations')).toBe(kinds.map((entry) => entry.key).indexOf('vitals') + 1);
    for (const marker of ['userIdentity', 'department', 'visitType', 'externalRef', 'streamContext', 'materializeAs']) {
      expect(investigations[marker], marker).toBeUndefined();
    }
    // Optional at the KIND level, exactly like vitals — a console-opened consultation sends none.
    expect(investigations.required).toBeUndefined();
  });

  it('has the pinned `results` array shape', () => {
    expect(investigations.fields).toEqual({
      type: 'object',
      properties: {
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            required: ['name', 'value'],
            properties: {
              name: { type: 'string', maxLength: 200 },
              value: { type: ['string', 'number'] },
              unit: { type: 'string', maxLength: 40 },
              refRange: { type: 'string', maxLength: 80 },
              collectedAt: { type: 'string', maxLength: 40 },
              flag: { type: 'string', maxLength: 20 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });
    expect(investigations.label).toBeTruthy();
    expect(investigations.description).toMatch(/results/i);
  });
});
