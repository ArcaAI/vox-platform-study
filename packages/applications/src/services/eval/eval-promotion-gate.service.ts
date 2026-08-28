import { Injectable, Logger } from '@nestjs/common';
import { WorkflowDefinitionRepository } from '@arcaai/domains';
import { WORKFLOW_NODE_REGISTRY, type WorkflowGraph, type WorkflowGraphNode, type WorkflowNodeEvalGate } from '@arcaai/workflow-contract';
import {
  AGENTIC_EVAL_PROMOTION_GATE_DEFAULT,
  AGENTIC_EVAL_PROMOTION_GATE_KEY,
  EvalPromotionGateMode,
} from '../settings-registry/descriptors/agentic-eval.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { EvalRunService } from './eval-run.service';

/**
 * OD-11 helpers — reading the eval gate off a graph node.
 *
 * Kept module-local rather than exported: this is the only consumer, and a
 * shared helper would invite a second discovery path, which is exactly how the
 * pre-TASK-815 gate ended up with capability columns it did not know about.
 */
function graphNodes(graph: unknown): WorkflowGraphNode[] {
  const nodes = (graph as WorkflowGraph | null | undefined)?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function nodeConfig(node: WorkflowGraphNode): Record<string, unknown> {
  const config = node.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

function readBoundTemplateId(node: WorkflowGraphNode): string | null {
  const value = nodeConfig(node).promptTemplateId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The gate governing this node: the INSTANCE binding it carries, or — when it
 * carries none — the node TYPE's declared default from the registry.
 *
 * Both layers exist deliberately. The descriptor (TASK-809) is a code-owned
 * constant shared by every tenant, so it can only express a platform default;
 * the instance config (TASK-815) is where a tenant's own `goldenSetId` and its
 * enable/disable toggle live. Instance wins, because a tenant that has said
 * something has said it about their own data.
 */
function resolveNodeEvalGate(node: WorkflowGraphNode): WorkflowNodeEvalGate | null {
  const raw = nodeConfig(node).evalGate;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const { goldenSetId, enabled } = raw as { goldenSetId?: unknown; enabled?: unknown };
    if (typeof goldenSetId === 'string' && typeof enabled === 'boolean') {
      return { goldenSetId, enabled };
    }
  }
  return WORKFLOW_NODE_REGISTRY[node.type]?.evalGate ?? null;
}

export interface EvaluatePromotionInput {
  tenantId: string;
  /** The template being promoted (approved) / whose pin is being re-pointed. */
  promptTemplateId: string;
  /** The PromptVersion number being pinned (pin re-point); null/undefined for approve. */
  promptVersionNumber?: number | null;
  /**
   * Restrict to ONE workflow NODE (pin re-point). Omit to gate every bound node
   * (approve).
   *
   * Named `agentId` because `PromptManagementService` passes through what
   * `ResolvedPromptConfig.resolvedAgentId` gave it, and that field is part of a
   * frozen v1-compat contract. Since TASK-815 the value it carries is a
   * workflow node id.
   */
  agentId?: string;
  /** What triggered the gate — audit/telemetry only. */
  trigger: 'approve' | 'pin';
}

export interface PromotionGateVerdict {
  mode: EvalPromotionGateMode;
  /** Did any eval actually run? (false in off-mode or when no golden set is attached). */
  evaluated: boolean;
  /** Overall pass — false if ANY run failed. Vacuously true when nothing ran. */
  passed: boolean;
  /** The promotion must be REJECTED (409). Only true in block-mode with a failed eval. */
  blocked: boolean;
  failures: string[];
  runIds: string[];
  aggregates: Record<string, number>;
  /** Set when the promotion proceeded UNGATED (no golden set) — a recorded warning. */
  warning?: string;
}

/**
 * EvalPromotionGateService — the OD-3 mandatory eval gate on template approval
 * and prompt pin re-point.
 *
 * If a WORKFLOW NODE bound to the template carries an ENABLED `evalGate`, the
 * gate runs the eval synchronously (persisting an `EvalRun` with
 * `triggerType=PROMOTION`) and, in `block` mode, reports `blocked=true` on
 * failure so the caller can reject with a 409. `warn` records but never blocks;
 * `off` skips the eval entirely. No enabled gate ⇒ the promotion proceeds with a
 * recorded warning (never blocked). The mode comes from the super-admin-only
 * `agentic.eval.promotionGate` registry setting.
 *
 * ## What TASK-815 / OD-11 changed, and what it did not
 *
 * ONLY DISCOVERY. The gate used to find golden sets through
 * `DepartmentAgentRepository.findByBoundTemplate`, which was the only path that
 * existed. With `DepartmentAgent` retired, the binding lives on the NODE that
 * references the template (`config.evalGate`), and discovery walks the tenant's
 * ACTIVE PUBLISHED definitions to find it. The three modes, the 409
 * `EVAL_GATE_FAILED` contract in `PromptManagementService.approveTemplate()`,
 * and the no-golden-set warning are all untouched. OD-11's first reading —
 * "retire the gate with the agent" — was withdrawn by the owner: a safety
 * control must not vanish because the row it happened to hang off did.
 *
 * ## The one thing this service must never do
 *
 * Degrade a READ FAILURE into "no golden set". Every other resolver in this
 * area is deliberately tolerant, because a failed prompt read must not fail a
 * clinical generation. This one is the opposite: swallowing a definition-read
 * error here turns a database outage into a silently ungated approval, which is
 * precisely the outcome the gate exists to prevent. The read is therefore
 * unguarded and the exception propagates to the caller.
 *
 * DOCUMENTED LIMITATION (carried over from the agent-sourced gate): the
 * golden-set eval judges transcript -> final-note quality, which is meaningless
 * for a live delta prompt or a pre-summary prompt. The gate therefore governs
 * finalize bindings in substance; other bindings are gated by APPROVED status
 * alone. Extending eval coverage to other capabilities is an explicit follow-on.
 */
@Injectable()
export class EvalPromotionGateService {
  private readonly logger = new Logger(EvalPromotionGateService.name);

  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly evalRunService: EvalRunService,
    private readonly effectiveSettings: EffectiveSettingsService,
  ) {}

  async evaluatePromotion(input: EvaluatePromotionInput): Promise<PromotionGateVerdict> {
    const { tenantId, promptTemplateId } = input;
    const mode = await this.resolveMode(tenantId);

    const empty: PromotionGateVerdict = {
      mode,
      evaluated: false,
      passed: true,
      blocked: false,
      failures: [],
      runIds: [],
      aggregates: {},
    };

    if (mode === 'off') {
      return empty;
    }

    // Find the NODES bound to this template that carry an ENABLED gate. For a
    // pin re-point we gate only the one node; for an approve we gate every bound
    // node across every ACTIVE PUBLISHED definition the tenant owns — a template
    // shared by two workflows is gated by both, which is the whole reason the
    // binding sits on the node rather than on the template.
    //
    // Deliberately NOT wrapped in a try/catch: see the class docstring.
    const definitions = await this.workflowDefinitionRepository.findActivePublishedByTenant(tenantId);

    const goldenSetIds: string[] = [];
    const seen = new Set<string>();
    for (const definition of definitions) {
      for (const node of graphNodes(definition?.graph)) {
        if (input.agentId !== undefined && node.id !== input.agentId) continue;
        if (readBoundTemplateId(node) !== promptTemplateId) continue;
        const gate = resolveNodeEvalGate(node);
        // `enabled: false` is the OD-11 tenant-admin toggle: an explicit
        // decision to proceed ungated, which lands on the same warning path as
        // "no golden set attached" always did.
        if (!gate?.enabled || gate.goldenSetId.length === 0) continue;
        // One eval per golden set. Two nodes sharing a set is one question, and
        // the eval is an expensive external call.
        if (seen.has(gate.goldenSetId)) continue;
        seen.add(gate.goldenSetId);
        goldenSetIds.push(gate.goldenSetId);
      }
    }

    if (goldenSetIds.length === 0) {
      return {
        ...empty,
        warning: 'No golden set is attached to an enabled eval gate on a bound workflow node — the promotion proceeded ungated.',
      };
    }

    const failures: string[] = [];
    const runIds: string[] = [];
    let aggregates: Record<string, number> = {};
    let allPassed = true;

    for (const goldenSetId of goldenSetIds) {
      const outcome = await this.evalRunService.runGoldenSet({
        goldenSetId,
        tenantId,
        triggerType: 'PROMOTION',
        promptTemplateId,
        promptVersionNumber: input.promptVersionNumber ?? null,
      });
      runIds.push(outcome.run.id);
      aggregates = { ...aggregates, ...outcome.aggregates };
      if (!outcome.passed) {
        allPassed = false;
        failures.push(...outcome.failures);
      }
    }

    const blocked = mode === 'block' && !allPassed;
    if (!allPassed) {
      this.logger.warn(
        `Promotion gate ${blocked ? 'BLOCKED' : 'WARNED'} (mode=${mode}, trigger=${input.trigger}, template=${promptTemplateId}): ${failures.join('; ')}`,
      );
    }

    return { mode, evaluated: true, passed: allPassed, blocked, failures, runIds, aggregates };
  }

  private async resolveMode(tenantId: string): Promise<EvalPromotionGateMode> {
    try {
      const resolved = await this.effectiveSettings.resolveEffective(AGENTIC_EVAL_PROMOTION_GATE_KEY, { tenantId });
      const value = resolved.value;
      if (value === 'block' || value === 'warn' || value === 'off') return value;
      return AGENTIC_EVAL_PROMOTION_GATE_DEFAULT;
    } catch {
      // Fail-safe toward the mandatory default (block) — a resolver outage must
      // never silently disable the gate.
      return AGENTIC_EVAL_PROMOTION_GATE_DEFAULT;
    }
  }
}
