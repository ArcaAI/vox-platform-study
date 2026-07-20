import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ResourceType } from '@arcaai/domains';
import { BaseService } from '../../common/base.service';
import { IActiveUserContext } from '../../interfaces';
import { HarnessPolicyService } from '../harness-policy/harness-policy.service';
import { PromptResolutionService } from '../consultation/prompt/prompt-resolution.service';
import { AgenticInstructionsResolveOptions } from './IAgenticInstructionsService';
import { AgenticInstructionsResponse, SafetyCriterionResponse, SensorThresholdsResponse } from './dto';

/**
 * the vendored PDSQI-9 LLM-as-judge instrument pin.
 *
 * The judge prompt itself is vendored in the harness (Python — Epic's
 * open-source PDSQI-9 instrument, `apps/harness/.../eval/judge/prompts.py`) and
 * is NON-EDITABLE by license/science. This surface exposes only its identity:
 * name, pinned version, source/license/DOI, its validated rubric dimensions, and
 * a stable content fingerprint. `JUDGE_PROMPT_HASH` is computed deterministically
 * over the pinned identity + rubric surface so the read is reproducible.
 */
export const JUDGE_PROMPT_INSTRUMENT = 'PDSQI-9';
export const JUDGE_PROMPT_VERSION = '1.0.0';
export const JUDGE_PROMPT_SOURCE = 'epic-open-source/evaluation-instruments';
export const JUDGE_PROMPT_LICENSE = 'Apache-2.0';
export const JUDGE_PROMPT_PAPER_DOI = '10.1093/jamia/ocaf068';

/** The validated PDSQI-9 rubric dimensions (verbatim keys from the vendored instrument). */
export const JUDGE_RUBRIC_DIMENSIONS: readonly string[] = [
  'citation',
  'accurate',
  'thorough',
  'useful',
  'organized',
  'comprehensible',
  'succinct',
  'abstraction',
  'synthesized',
  'voice_summ',
  'voice_note',
];

/** Deterministic content fingerprint of the pinned instrument identity + rubric surface. */
export const JUDGE_PROMPT_HASH = createHash('sha256')
  .update(`${JUDGE_PROMPT_INSTRUMENT}@${JUDGE_PROMPT_VERSION}:${JUDGE_RUBRIC_DIMENSIONS.join(',')}`)
  .digest('hex');

/**
 * AgenticInstructionsService.
 *
 * Read-only inventory of the EFFECTIVE agentic instruction set for one tenant.
 * It composes existing sources — it neither reads Prisma nor mutates anything:
 *  - `HarnessPolicyService.getEffectivePolicy` → sensor thresholds + safety knobs
 *    + the resolution source.
 *  - `PromptResolutionService.resolve` → the resolved prompt tier
 *    (Tier-0 preferred → department → default).
 *  - the vendored PDSQI judge-prompt pin (constant, read-only).
 *
 * Extends `BaseService` for CLS/context parity with the other admin services;
 * it broadcasts no sys-event (nothing is mutated).
 */
@Injectable()
export class AgenticInstructionsService extends BaseService {
  constructor(
    private readonly harnessPolicyService: HarnessPolicyService,
    private readonly promptResolutionService: PromptResolutionService,
    eventEmitter: EventEmitter2,
    clsService: ClsService<IActiveUserContext>,
  ) {
    // Read-only surface; the resource type is inert (no broadcastSysEvent call).
    super(eventEmitter, clsService, ResourceType.PromptTemplate);
  }

  async getEffectiveInstructions(tenantId: string, options: AgenticInstructionsResolveOptions = {}): Promise<AgenticInstructionsResponse> {
    const promptType = options.promptType ?? 'new-patient';

    const [policy, tier] = await Promise.all([
      this.harnessPolicyService.getEffectivePolicy(tenantId),
      this.promptResolutionService.resolve({
        departmentId: options.departmentId,
        promptType,
      }),
    ]);

    const sensorThresholds: SensorThresholdsResponse = {
      entityFaithfulnessThreshold: policy.entityFaithfulnessThreshold,
      coverageThreshold: policy.coverageThreshold,
      citationPresenceThreshold: policy.citationPresenceThreshold,
      numericDoseThreshold: policy.numericDoseThreshold,
      groundednessThreshold: policy.groundednessThreshold,
    };

    const safetyCriteria: SafetyCriterionResponse[] = [
      {
        key: 'safety',
        label: 'Content-safety guardrail',
        enabled: policy.safetyEnabled,
        detail: `${policy.safetyProvider}/${policy.safetyModel}`,
      },
      {
        key: 'phi',
        label: 'PHI detection',
        enabled: policy.phiEnabled,
        detail: policy.phiFailClosed ? 'fail-closed' : 'fail-open',
      },
    ];

    return {
      tenantId,
      policySource: policy.source,
      promptTier: {
        template: tier.template,
        promptId: tier.promptId,
        resolvedFrom: tier.resolvedFrom,
        departmentId: options.departmentId ?? null,
        promptType,
      },
      judgePrompt: {
        instrument: JUDGE_PROMPT_INSTRUMENT,
        version: JUDGE_PROMPT_VERSION,
        promptHash: JUDGE_PROMPT_HASH,
        source: JUDGE_PROMPT_SOURCE,
        license: JUDGE_PROMPT_LICENSE,
        paperDoi: JUDGE_PROMPT_PAPER_DOI,
        rubricDimensions: [...JUDGE_RUBRIC_DIMENSIONS],
        editable: false,
      },
      sensorThresholds,
      safetyCriteria,
    };
  }
}
