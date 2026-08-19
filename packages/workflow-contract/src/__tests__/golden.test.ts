/**
 * The golden suite (TASK-716 Task 6): table-driven over `__tests__/golden/<ruleId>/`. Each
 * rule in `DRAFT_SUMMARIZATION_RULE_SET` (and, since TASK-724 Task 3, `DRAFT_STT_RULE_SET`) gets
 * a `pass.graph.json` (no finding for that ruleId) and a `fail.graph.json` (at least one finding
 * for that ruleId, right severity). This is the audit artifact turned into executable tests, per
 * design.md §Testing strategy — but see `rule-catalogue.ts`'s module docstring: the rule SETs
 * themselves remain DRAFT/unreviewed. A passing golden suite proves the ENGINE evaluates these
 * rule instances correctly; it does not prove the rule instances are the clinically-correct ones.
 *
 * Multi-palette, table-driven over `ALL_RULES` (both catalogues merged) rather than one palette's
 * array — a rule's `ruleId` prefix is unique across every palette today (`WF-S-*`/`WF-I-*`/
 * `WF-SUMM-*` vs `WF-STT-*`), so one flat fixture-directory namespace and one evaluation context
 * per rule (keyed off the rule's OWN `paletteKey`, not a single hardcoded palette) is sufficient —
 * adding a third palette's rule set here is exactly "append to ALL_RULES", no new mechanism.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { evaluatePredicate } from '../predicates';
import type { WorkflowEvaluationContext } from '../predicates/context';
import { DRAFT_CONSULTATION_RULE_SET, DRAFT_STT_RULE_SET, DRAFT_SUMMARIZATION_RULE_SET } from '../rule-catalogue';
import type { DraftWorkflowRule } from '../rule-catalogue';

const GOLDEN_DIR = path.join(__dirname, 'golden');

const NODE_CLASSES: Record<string, readonly string[]> = {
  'summarization.generate': ['generation', 'activity'],
  'redact.phi': ['redaction'],
  'phi.read': ['phiBearing'],
  'egress.external': ['externalEgress'],
  'consent.gate': ['consentGate', 'mandatory'],
  'sign.node': ['signing'],
  'draft.output': ['draftLabeled'],
  'code.bind': ['codeBinding'],
  'tool.verify': ['toolVerification'],
  'style.dna': ['styleDna'],
  'commit.external': ['externalCommit', 'activity'],
  'cloud.route': ['cloudProviderRouting', 'activity'],
  // Mirrors the real registry: the two graph boundary markers, which the reachability
  // predicates exempt from a palette's own entry/terminal rule (predicates/structural.ts).
  'core.start': ['boundary'],
  'core.end': ['boundary'],
};

const ALL_RULES: readonly DraftWorkflowRule[] = [
  ...DRAFT_SUMMARIZATION_RULE_SET,
  ...DRAFT_STT_RULE_SET,
  ...DRAFT_CONSULTATION_RULE_SET,
];

/** One context per palette a rule can declare — STT's rules select purely by `nodeType`, so its
 *  `classesOf` stub is never consulted, but the shape is kept parallel to the summarization
 *  context for the same "generic engine" reason `validate.ts`'s merge is additive. */
function contextFor(paletteKey: string): WorkflowEvaluationContext {
  return {
    paletteKey,
    registry: {
      classesOf: (type: string) => NODE_CLASSES[type] ?? [],
      paletteOf: () => paletteKey,
    },
  };
}

function loadGraph(ruleId: string, file: 'pass.graph.json' | 'fail.graph.json'): WorkflowGraph {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, ruleId, file), 'utf8')) as WorkflowGraph;
}

const ruleDirectories = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('golden suite — one pass/fail fixture pair per implemented rule', () => {
  it('has a fixture directory for every rule across every palette catalogue (parity)', () => {
    const catalogueIds = ALL_RULES.map((r) => r.ruleId).sort();
    expect(ruleDirectories).toEqual(catalogueIds);
  });

  for (const ruleId of ruleDirectories) {
    const rule = ALL_RULES.find((r) => r.ruleId === ruleId);

    it(`${ruleId}: defined in a palette rule catalogue`, () => {
      expect(rule).toBeDefined();
    });

    if (!rule) continue;

    // A rule with paletteKey: null (palette-agnostic) is evaluated under a nominal
    // 'summarization' context — matches every existing WF-S-*/WF-I-* fixture's authored
    // node vocabulary, unchanged from before this file's multi-palette generalization.
    const ctx = contextFor(rule.paletteKey ?? 'summarization');

    it(`${ruleId}: pass fixture yields no finding for this rule`, () => {
      const graph = loadGraph(ruleId, 'pass.graph.json');
      const findings = evaluatePredicate(rule.predicateType, graph, ctx, rule.predicateConfig, rule.ruleId, {
        severity: rule.severity,
        ruleClass: rule.ruleClass,
      });
      expect(findings.filter((f) => f.ruleId === ruleId)).toEqual([]);
    });

    it(`${ruleId}: fail fixture yields at least one finding with the right ruleId and severity`, () => {
      const graph = loadGraph(ruleId, 'fail.graph.json');
      const findings = evaluatePredicate(rule.predicateType, graph, ctx, rule.predicateConfig, rule.ruleId, {
        severity: rule.severity,
        ruleClass: rule.ruleClass,
      });
      const own = findings.filter((f) => f.ruleId === ruleId);
      expect(own.length).toBeGreaterThanOrEqual(1);
      for (const finding of own) {
        expect(finding.severity).toBe(rule.severity);
        expect(finding.ruleClass).toBe(rule.ruleClass);
      }
    });
  }
});
