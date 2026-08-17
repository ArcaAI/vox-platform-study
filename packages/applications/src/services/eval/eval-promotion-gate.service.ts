import { Injectable, Logger } from '@nestjs/common';
import { DepartmentAgentRepository } from '@arcaai/domains';
import {
  AGENTIC_EVAL_PROMOTION_GATE_DEFAULT,
  AGENTIC_EVAL_PROMOTION_GATE_KEY,
  EvalPromotionGateMode,
} from '../settings-registry/descriptors/agentic-eval.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { EvalRunService } from './eval-run.service';

export interface EvaluatePromotionInput {
  tenantId: string;
  /** The template being promoted (approved) / whose pin is being re-pointed. */
  promptTemplateId: string;
  /** The PromptVersion number being pinned (pin re-point); null/undefined for approve. */
  promptVersionNumber?: number | null;
  /** Restrict to ONE agent (pin re-point). Omit to gate ALL agents bound to the template (approve). */
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
 * and DepartmentAgent pin re-point.
 *
 * If a department agent bound to the template references a `goldenSetId`, the
 * gate runs the eval synchronously (persisting an `EvalRun` with
 * `triggerType=PROMOTION`) and, in `block` mode, reports `blocked=true` on
 * failure so the caller can reject with a 409. `warn` records but never blocks;
 * `off` skips the eval entirely. No golden set ⇒ the promotion proceeds with a
 * recorded warning (never blocked). The mode comes from the super-admin-only
 * `agentic.eval.promotionGate` registry setting.
 */
@Injectable()
export class EvalPromotionGateService {
  private readonly logger = new Logger(EvalPromotionGateService.name);

  constructor(
    private readonly agentRepository: DepartmentAgentRepository,
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

    // Find the agents bound to this template that carry a golden set. For a pin
    // re-point we gate only the one agent; for an approve we gate every bound agent.
    //
    // This used to filter on `promptTemplateId` alone, which sees
    // only the BASE binding. Since C2 an agent can bind a template SOLELY through
    // a capability column (`newPatientTemplateId` / `revisitTemplateId` /
    // `preSummaryTemplateId` / `livePromptTemplateId`), and such an agent would
    // have escaped the gate entirely at approve time. `findByBoundTemplate` ORs
    // across all five columns.
    //
    // DOCUMENTED LIMITATION (C1 -1): the golden-set eval judges
    // transcript→final-note quality, which is meaningless for a live DELTA prompt
    // or a pre-summary prompt. The gate therefore governs the SUMMARY bindings in
    // substance; live/pre-summary bindings are gated by APPROVED status alone.
    // Extending eval coverage to other capabilities is an explicit follow-on.
    const agents = await this.agentRepository.findByBoundTemplate(tenantId, promptTemplateId);
    const gated = agents.filter((a) => !!a.goldenSetId && (input.agentId === undefined || a.id === input.agentId));

    if (gated.length === 0) {
      return {
        ...empty,
        warning: 'No golden set is attached to a bound agent — the promotion proceeded ungated.',
      };
    }

    const failures: string[] = [];
    const runIds: string[] = [];
    let aggregates: Record<string, number> = {};
    let allPassed = true;

    for (const a of gated) {
      const outcome = await this.evalRunService.runGoldenSet({
        goldenSetId: a.goldenSetId as string,
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
