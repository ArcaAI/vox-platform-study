/**
 * The pure validation orchestrator: shape check → every applicable rule → one report. Total —
 * a malformed rule row (bad `predicateConfig`) or a throwing evaluator both resolve to a
 * synthetic `WF-INTERNAL` ERROR finding, never to `ok: true` (§3.5).
 *
 * NOT wired to anything in the application layer in this session — see `rule-catalogue.ts`'s
 * module docstring for why, and the ticket README §7 for what remains for Task 8.
 */
import { canonicalJson } from './canonical-json';
import type { WorkflowGraph } from './graph-model';
import { workflowGraphProblems } from './graph-model';
import { evaluatePredicate, predicateConfigProblems } from './predicates';
import type { WorkflowEvaluationContext } from './predicates/context';
import { buildValidationReport, internalErrorFinding } from './report';
import type { WorkflowFinding, WorkflowValidationReport } from './report';
import { DRAFT_SUMMARIZATION_RULE_SET } from './rule-catalogue';
import type { DraftWorkflowRule } from './rule-catalogue';

export interface ValidateOptions {
  /** Defaults to `DRAFT_SUMMARIZATION_RULE_SET` — see that module's DRAFT status header. */
  rules?: readonly DraftWorkflowRule[];
  ruleSetVersion: number;
  registryChecksum: string;
  evaluatedAt?: string;
}

/** `undefined` — treated the same as `unknown` here: `canonicalJson`/`JSON.stringify(undefined)` is `undefined`, not valid JSON. */
function ruleConfigChecksumSafe(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function validate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, options: ValidateOptions): WorkflowValidationReport {
  const shapeProblems = workflowGraphProblems(graph);
  if (shapeProblems.length > 0) {
    const findings: WorkflowFinding[] = shapeProblems.map((message) => ({
      ruleId: 'WF-SHAPE',
      ruleClass: 'structural',
      severity: 'ERROR',
      nodeId: null,
      message,
    }));
    return buildValidationReport(findings, options);
  }

  const rules = options.rules ?? DRAFT_SUMMARIZATION_RULE_SET;
  const findings: WorkflowFinding[] = [];

  for (const rule of rules) {
    if (rule.paletteKey !== null && rule.paletteKey !== ctx.paletteKey) continue;

    let configProblems: string[];
    try {
      configProblems = predicateConfigProblems(rule.predicateType, ruleConfigChecksumSafe(rule.predicateConfig));
    } catch (error) {
      findings.push(internalErrorFinding(rule.ruleId, rule.ruleClass, error));
      continue;
    }
    if (configProblems.length > 0) {
      findings.push(internalErrorFinding(rule.ruleId, rule.ruleClass, new Error(`malformed predicateConfig: ${configProblems.join('; ')}`)));
      continue;
    }

    findings.push(
      ...evaluatePredicate(rule.predicateType, graph, ctx, rule.predicateConfig, rule.ruleId, {
        severity: rule.severity,
        ruleClass: rule.ruleClass,
        registerRefs: rule.registerRefs,
      }),
    );
  }

  return buildValidationReport(findings, options);
}

// Re-exported so a consumer that only imports `validate` can still hash a graph the same way
// the compiler does, without a second import.
export { canonicalJson };
