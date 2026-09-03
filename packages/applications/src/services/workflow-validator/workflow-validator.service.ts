/**
 * WorkflowValidatorService — the IMPURE half of validator.
 *
 * The split this service exists to hold (mirroring
 * `departmentAgent/constants.ts`'s "pure functions here, the repository-backed
 * half in the service"):
 *
 * | Pure — `@arcaai/workflow-contract` | Impure — here |
 * |-----------------------------------------|----------------------------------------|
 * | graph algorithms, predicate evaluators | loading rule ROWS (SYSTEM ∪ tenant) |
 * | `validate()` over a GIVEN rule set | computing `ruleSetVersion` |
 * | the compiler | the one-way-strictness merge |
 *
 * Deliberately NOT here: persisting the report and broadcasting the sys-event.
 * `WorkflowDefinitionService` already owns the definition lifecycle
 * and does both; a second writer would double-broadcast `ResourceUpdated` on
 * every validate. This service resolves and evaluates — the caller decides what
 * to do with the verdict.
 *
 * TOTALITY IS THE CONTRACT: "a validator that is not total is a validator
 * that can be bypassed." Every failure path in this file — a repository throw, a
 * DB row naming a predicate kind the code catalogue does not have, a malformed
 * `predicateConfig` — resolves to a synthetic `WF-INTERNAL` ERROR finding and
 * `ok: false`. None of them resolves to `ok: true`, and none of them throws.
 */
import { Injectable } from '@nestjs/common';
import { WorkflowInvariantRuleRepository } from '@arcaai/domains';
import {
  ALL_DRAFT_RULES,
  WORKFLOW_RULE_PREDICATE_TYPES,
  buildValidationReport,
  internalErrorFinding,
  registryChecksum,
  validate,
  workflowNodeClassLookup,
} from '@arcaai/workflow-contract';
import type { DraftWorkflowRule, WorkflowFinding, WorkflowGraph, WorkflowRuleClass, WorkflowValidationReport } from '@arcaai/workflow-contract';
import { mergeRuleSets, type ResolvedRule } from './rule-merge';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** `ruleSetVersion` stamped when NO `WorkflowInvariantRule` row applies and the bundled code
 *  catalogue is used instead — distinguishable from a real seeded version 1. */
const UNSEEDED_RULE_SET_VERSION = 0;

/** The rule CLASS is not a column: it is implied by the rule id's family, the same convention
 *  `contracts/rule-model.md` documents (`WF-S-*` structural, `WF-C-*` schema, everything else
 *  invariant). Kept as one function so the mapping is stated once. */
function ruleClassOf(ruleId: string): WorkflowRuleClass {
  if (ruleId.startsWith('WF-S-')) return 'structural';
  if (ruleId.startsWith('WF-C-')) return 'schema';
  return 'invariant';
}

/** A row shaped loosely enough to accept both the domain entity and a test double. */
interface RuleRowLike {
  ruleId: string;
  predicateType: string;
  predicateConfig: unknown;
  severity: string;
  paletteKey?: string | null;
  registerRefs?: readonly string[];
  title: string;
  tenantId: string;
  ruleVersion: number;
}

@Injectable()
export class WorkflowValidatorService {
  constructor(private readonly workflowInvariantRuleRepository: WorkflowInvariantRuleRepository) {}

  /**
   * Resolve the applicable rule set for `(tenantId, paletteKey)` and evaluate `graph` against it.
   *
   * Never throws. A resolution failure becomes a `WF-INTERNAL` ERROR finding — the report is the
   * only channel, because a caller that receives an exception has no verdict at all and the
   * publish path must not be able to interpret "no verdict" as "fine".
   */
  async validateGraph(tenantId: string, paletteKey: string, graph: WorkflowGraph): Promise<WorkflowValidationReport> {
    let rules: ResolvedRule[];
    let ruleSetVersion: number;

    try {
      const resolved = await this.resolveRuleSet(tenantId, paletteKey);
      rules = resolved.rules;
      ruleSetVersion = resolved.ruleSetVersion;
    } catch (error) {
      return buildValidationReport([internalErrorFinding('WF-RULESET', 'invariant', error)], {
        ruleSetVersion: UNSEEDED_RULE_SET_VERSION,
        registryChecksum: registryChecksum(),
      });
    }

    // `validate()` is itself total (a throwing evaluator resolves to WF-INTERNAL inside it), but
    // the outer guard costs nothing and covers the registry/checksum calls too.
    try {
      return validate(
        graph,
        { paletteKey, registry: workflowNodeClassLookup },
        { rules: rules as unknown as readonly DraftWorkflowRule[], ruleSetVersion, registryChecksum: registryChecksum() },
      );
    } catch (error) {
      const findings: WorkflowFinding[] = [internalErrorFinding('WF-EVALUATE', 'invariant', error)];
      return buildValidationReport(findings, { ruleSetVersion, registryChecksum: registryChecksum() });
    }
  }

  /** The merged max `ruleVersion` — what the re-validation sweep compares a published
   *  definition's stored `ruleSetVersion` against to decide `NEEDS_REVIEW`. */
  async resolveRuleSetVersion(tenantId: string, paletteKey: string): Promise<number> {
    const { ruleSetVersion } = await this.resolveRuleSet(tenantId, paletteKey);
    return ruleSetVersion;
  }

  /**
   * SYSTEM register ∪ tenant additions, merged one-way-strict.
   *
   * When no row applies at all the bundled DRAFT catalogue stands in, stamped
   * `ruleSetVersion: 0`. That fallback is deliberate: on a database whose rule table has not
   * been seeded yet, returning an EMPTY rule set would make every graph validate clean — a
   * silent, total loss of the safety boundary that looks exactly like success.
   *
   * The stand-in is `ALL_DRAFT_RULES` — EVERY palette's bundled set, which is also what
   * `validate()` uses when a caller supplies no `rules` at all. It used to be
   * `DRAFT_SUMMARIZATION_RULE_SET` alone, which was a narrower loss of the same boundary rather
   * than an obvious one: `validate()` skips any rule whose `paletteKey` does not match the
   * graph's, so a consultation graph matched only the palette-agnostic `WF-S-*` rows and every
   * `WF-CONS-*` clinical invariant (mandatory nodes, consent/HITL reachability) silently never
   * evaluated — on a report that still said `ok: true`.
   */
  private async resolveRuleSet(tenantId: string, paletteKey: string): Promise<{ rules: ResolvedRule[]; ruleSetVersion: number }> {
    const rows = (await this.workflowInvariantRuleRepository.findApplicable(tenantId, paletteKey)) as unknown as RuleRowLike[];

    if (rows.length === 0) {
      return {
        rules: ALL_DRAFT_RULES.map((rule) => ({ ...rule, tenantId: SYSTEM_TENANT_ID, ruleVersion: 1 })),
        ruleSetVersion: UNSEEDED_RULE_SET_VERSION,
      };
    }

    const systemRules: ResolvedRule[] = [];
    const tenantRules: ResolvedRule[] = [];

    for (const row of rows) {
      const rule = this.toResolvedRule(row);
      (row.tenantId === SYSTEM_TENANT_ID ? systemRules : tenantRules).push(rule);
    }

    const rules = mergeRuleSets(systemRules, tenantRules);
    const ruleSetVersion = rules.reduce((max, rule) => (rule.ruleVersion > max ? rule.ruleVersion : max), 0);
    return { rules, ruleSetVersion };
  }

  /**
   * Row → evaluable rule.
   *
   * A `predicateType` the code-owned catalogue does not have means the Prisma enum and
   * `WORKFLOW_RULE_PREDICATE_TYPES` have drifted. Skipping such a row would silently shrink the
   * rule set, so it is mapped to a deliberately-unsatisfiable marker instead: `validate()`'s own
   * dispatcher rejects the unknown kind and emits `WF-INTERNAL`, making the drift loud.
   */
  private toResolvedRule(row: RuleRowLike): ResolvedRule {
    const known = (WORKFLOW_RULE_PREDICATE_TYPES as readonly string[]).includes(row.predicateType);
    return {
      ruleId: row.ruleId,
      ruleClass: ruleClassOf(row.ruleId),
      predicateType: (known ? row.predicateType : '__UNKNOWN_PREDICATE__') as ResolvedRule['predicateType'],
      predicateConfig: row.predicateConfig,
      severity: row.severity === 'WARNING' ? 'WARNING' : 'ERROR',
      paletteKey: row.paletteKey ?? null,
      registerRefs: row.registerRefs ?? [],
      title: row.title,
      tenantId: row.tenantId,
      ruleVersion: row.ruleVersion,
    };
  }
}
