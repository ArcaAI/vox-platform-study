/**
 * The golden suite (TASK-716 Task 6): table-driven over `__tests__/golden/<ruleId>/`. Each
 * rule in `DRAFT_SUMMARIZATION_RULE_SET` gets a `pass.graph.json` (no finding for that ruleId)
 * and a `fail.graph.json` (at least one finding for that ruleId, right severity). This is the
 * audit artifact turned into executable tests, per design.md §Testing strategy — but see
 * `rule-catalogue.ts`'s module docstring: the rule SET itself remains DRAFT/unreviewed. A
 * passing golden suite proves the ENGINE evaluates these 17 rule instances correctly; it does
 * not prove the 17 rule instances are the clinically-correct ones.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { evaluatePredicate } from '../predicates';
import type { WorkflowEvaluationContext } from '../predicates/context';
import { DRAFT_SUMMARIZATION_RULE_SET } from '../rule-catalogue';

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
};

const ctx: WorkflowEvaluationContext = {
  paletteKey: 'summarization',
  registry: {
    classesOf: (type: string) => NODE_CLASSES[type] ?? [],
    paletteOf: () => 'summarization',
  },
};

function loadGraph(ruleId: string, file: 'pass.graph.json' | 'fail.graph.json'): WorkflowGraph {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, ruleId, file), 'utf8')) as WorkflowGraph;
}

const ruleDirectories = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('golden suite — one pass/fail fixture pair per implemented rule', () => {
  it('has a fixture directory for every rule in the pure catalogue (parity)', () => {
    const catalogueIds = DRAFT_SUMMARIZATION_RULE_SET.map((r) => r.ruleId).sort();
    expect(ruleDirectories).toEqual(catalogueIds);
  });

  for (const ruleId of ruleDirectories) {
    const rule = DRAFT_SUMMARIZATION_RULE_SET.find((r) => r.ruleId === ruleId);

    it(`${ruleId}: defined in DRAFT_SUMMARIZATION_RULE_SET`, () => {
      expect(rule).toBeDefined();
    });

    if (!rule) continue;

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
