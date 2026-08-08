/**
 * TASK-635 C4 / C1 §C4 — the config-driven live TOOL LAYER (decision OD-5(b)).
 *
 * WHAT THIS IS. The live flush used to hardcode its tool orchestration: one NLP
 * `classify/tokens` call for entities+vitals, then an env-gated guardrail
 * groundedness check. This module relocates those two executors behind a small
 * registry keyed by {@link LiveToolKey}, so the session's frozen
 * {@link ResolvedToolPlan} (C3) — not the code — decides what runs.
 *
 * WHAT THIS IS NOT (OD-5(b), not (a)). There is NO model-initiated tool-calling
 * loop here, and no `tools` field is added to the SMR payload. A live flush must
 * hold a ~5s budget; a model-driven loop costs ≥1 extra serial LLM round-trip
 * per call with an unbounded worst case (C1 §9). The sanctioned path to OD-5(a)
 * later is {@link LiveToolExecutor.describe} + {@link LiveToolRegistry.describeAll}:
 * the descriptors are already tool-schema shaped, so that feature can arrive
 * without churning this interface or the `toolConfig` JSONB.
 *
 * ANTI-LAUNDERING, STRUCTURALLY. The extraction executor's input type
 * ({@link ExtractionToolInput}) carries `sourceText` and NOTHING ELSE — there is
 * no field on it through which the LLM-generated running note could reach NER.
 * That is the type-level half of the rule the flush enforces by passing
 * `delta || transcript`; the note is only ever consulted AFTERWARDS, by
 * `groundEntitiesToNote` (which is a consumer of NER output, not a tool).
 *
 * DEFAULTS ARE TODAY. `envDefaults` supplies the pre-C4 behavior for every tool
 * whose plan entry is `enabled: null` ("follow the platform/env default", which
 * is distinct from `false`). With a null/absent `toolConfig` the plan is
 * `DEFAULT_LIVE_TOOL_PLAN` — ner/vitals `true`, groundedness `null` → the
 * `LIVE_DOC_GROUNDEDNESS_ENABLED` env value — i.e. byte-identical behavior.
 */

import type { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ClsService } from 'nestjs-cls';
import type { SecretsService } from '../../baseServices/_meta/secrets';
import type { IAiTaskDefaultService } from '../../ai-task-default/IAiTaskDefaultService';
import type { IActiveUserContext } from '../../../interfaces';
import { resolveNerModelInjection } from '../shared/resolveNerModelSelection';
import { LIVE_TOOL_KEYS, type LiveToolKey } from '../../departmentAgent/constants';
import type { ResolvedToolPlan } from './live-agent.port';
import type { LiveSummaryEntityDto, LiveSummaryGroundednessDto, LiveSummaryGroundednessSegmentDto, LiveSummaryVitalsDto } from './dto';

// =============================================================================
// Interfaces
// =============================================================================

/**
 * A tool's self-description. Deliberately shaped like an LLM tool schema
 * (name / description / JSON-Schema parameters) so an OD-5(a) model-initiated
 * loop can serialize it directly — but nothing consumes it that way today.
 */
export interface LiveToolDescriptor {
  key: LiveToolKey;
  /** Wire/trajectory name — the same string the TOOL_CALL step records. */
  name: string;
  kind: 'extraction' | 'guardrail';
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * Input to an EXTRACTION tool. One field, by design: see the anti-laundering
 * note in the module header. Widening this with anything derived from generated
 * text would break the structural guarantee.
 */
export interface ExtractionToolInput {
  /** The raw transcript delta (`delta || transcript`) — never generated text. */
  sourceText: string;
}

export interface ExtractionToolOutput {
  entities: LiveSummaryEntityDto[];
  vitals?: LiveSummaryVitalsDto;
}

/** Input to the OUTPUT-side groundedness gate: generated note vs. its source. */
export interface GroundednessToolInput {
  /** The generated running note being verified. */
  summary: string;
  /** Transcript (∪ clinician notes) the note is checked against. */
  sourceText: string;
}

export interface LiveToolExecutor<TInput, TOutput> {
  readonly key: LiveToolKey;
  /** Wire/trajectory name (e.g. `nlp.classify-tokens`). */
  readonly name: string;
  /** OD-5(a) seam — static, cheap, and side-effect free. */
  describe(): LiveToolDescriptor;
  execute(input: TInput, signal?: AbortSignal): Promise<TOutput>;
}

export type ExtractionToolExecutor = LiveToolExecutor<ExtractionToolInput, ExtractionToolOutput>;
export type GroundednessToolExecutor = LiveToolExecutor<GroundednessToolInput, LiveSummaryGroundednessDto>;

// =============================================================================
// Descriptors (module-level: `describeAll()` must never construct an executor)
// =============================================================================

/**
 * `ner` and `vitals` are two PLAN keys served by ONE executor and ONE HTTP call
 * (the NLP response carries both blocks) — disabling `vitals` filters the block
 * out, it does not save a request. `groundedness` is its own call.
 */
export const NLP_CLASSIFY_TOKENS_TOOL = 'nlp.classify-tokens' as const;
export const GUARDRAIL_GROUNDEDNESS_TOOL = 'guardrail.groundedness' as const;

const DESCRIPTORS: Readonly<Record<LiveToolKey, LiveToolDescriptor>> = Object.freeze({
  ner: Object.freeze({
    key: 'ner',
    name: NLP_CLASSIFY_TOKENS_TOOL,
    kind: 'extraction',
    description: 'Extract clinical entities (with ICD-10 links where curated) from a raw transcript delta.',
    parameters: {
      type: 'object',
      properties: { sourceText: { type: 'string', description: 'Raw transcript text. Never generated/model output.' } },
      required: ['sourceText'],
    },
  }),
  vitals: Object.freeze({
    key: 'vitals',
    name: NLP_CLASSIFY_TOKENS_TOOL,
    kind: 'extraction',
    description: 'Deterministic vitals extraction — the vitals block of the same NLP token-classification response.',
    parameters: {
      type: 'object',
      properties: { sourceText: { type: 'string', description: 'Raw transcript text. Never generated/model output.' } },
      required: ['sourceText'],
    },
  }),
  groundedness: Object.freeze({
    key: 'groundedness',
    name: GUARDRAIL_GROUNDEDNESS_TOOL,
    kind: 'guardrail',
    description: 'Verify a generated note against its source transcript (NLI). Fail-closed: never returns `grounded` on error.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The generated note under verification.' },
        sourceText: { type: 'string', description: 'Transcript (∪ clinician notes) to verify against.' },
      },
      required: ['summary', 'sourceText'],
    },
  }),
}) as Readonly<Record<LiveToolKey, LiveToolDescriptor>>;

// =============================================================================
// Executors (bodies relocated verbatim from LiveDocumentationService)
// =============================================================================

export interface NlpExtractionToolDeps {
  httpService: HttpService;
  nlpServiceUrl: string;
  logger: Logger;
  cls?: ClsService<IActiveUserContext>;
  aiTaskDefaultService?: IAiTaskDefaultService;
  /** Resolves `NLP_SERVICE_TOKEN` for the authenticated gateway→NLP hop (same as the groundedness deps). */
  secretsService?: SecretsService;
}

/** `nlp.classify-tokens` — body moved from `LiveDocumentationService.callNlp` + `mapVitals`. */
export class NlpExtractionTool implements ExtractionToolExecutor {
  readonly key: LiveToolKey = 'ner';
  readonly name = NLP_CLASSIFY_TOKENS_TOOL;

  constructor(private readonly deps: NlpExtractionToolDeps) {}

  describe(): LiveToolDescriptor {
    return DESCRIPTORS.ner;
  }

  async execute(input: ExtractionToolInput, signal?: AbortSignal): Promise<ExtractionToolOutput> {
    // TASK-552 Lane A: inject the effective `nlp.ner` AiTaskDefault model
    // (mirrors AiInferenceController's playground mapping) so a global
    // admin's re-point governs the live plane too, not just the playground.
    // Fail-open: {} on any resolution hiccup, or when CLS isn't wired (the
    // live-doc service isn't otherwise request-scoped).
    const modelSelection = this.deps.cls ? await resolveNerModelInjection(this.deps.aiTaskDefaultService, this.deps.cls, this.deps.logger) : {};
    // The gateway→NLP hop is shared-secret authenticated the same way the
    // guardrail executor below already does it. This call omitted the header,
    // so wherever NLP enforces a token (`NLP_SERVICE_TOKEN` non-empty) entity
    // extraction was rejected and the live note silently lost its highlights —
    // the NLP twin of the SMR defect in `callSmr` (TASK-640).
    const serviceToken = (await this.deps.secretsService?.getSecretOptional('NLP_SERVICE_TOKEN')) ?? '';
    const response = await this.deps.httpService.axiosRef.post(
      `${this.deps.nlpServiceUrl}/api/v1/classify/tokens`,
      { text: input.sourceText, ...modelSelection },
      { timeout: 30000, signal, headers: { 'Content-Type': 'application/json', 'X-Service-Token': serviceToken } },
    );
    // Canonical NLP wire shape (apps/nlp schemas/common.py Entity): text / entity_type /
    // position.{start,end} / icd_code (deterministic OntologyLinker; present only for the
    // curated vocabulary, absent otherwise — carried through so the UI can chip ICD-10 codes).
    const raw = (response.data?.entities ?? []) as Array<{
      entity_type?: string;
      text?: string;
      confidence?: number;
      icd_code?: string | null;
      position?: { start?: number; end?: number };
    }>;
    const entities = raw.map((e) => ({
      text: e.text ?? '',
      type: e.entity_type ?? 'UNKNOWN',
      confidence: e.confidence,
      icd10: e.icd_code ?? undefined,
      start: e.position?.start,
      end: e.position?.end,
    }));
    return { entities, vitals: mapVitals(response.data?.vitals) };
  }
}

/**
 * Map the NLP `Vitals` wire shape (snake_case, null-safe deterministic
 * extraction) to `LiveSummaryVitalsDto`. Returns undefined when the NLP
 * service reported no vitals — never fabricated.
 */
export function mapVitals(raw: unknown): LiveSummaryVitalsDto | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as {
    systolic?: number | null;
    diastolic?: number | null;
    heart_rate?: number | null;
    spo2?: number | null;
    temperature_c?: number | null;
    weight_kg?: number | null;
  };
  const mapped: LiveSummaryVitalsDto = {
    ...(typeof v.systolic === 'number' ? { systolic: v.systolic } : {}),
    ...(typeof v.diastolic === 'number' ? { diastolic: v.diastolic } : {}),
    ...(typeof v.heart_rate === 'number' ? { heartRate: v.heart_rate } : {}),
    ...(typeof v.spo2 === 'number' ? { spo2: v.spo2 } : {}),
    ...(typeof v.temperature_c === 'number' ? { temperatureC: v.temperature_c } : {}),
    ...(typeof v.weight_kg === 'number' ? { weightKg: v.weight_kg } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export interface GroundednessToolDeps {
  httpService: HttpService;
  guardrailServiceUrl: string;
  logger: Logger;
  secretsService?: SecretsService;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

/**
 * `guardrail.groundedness` — body moved from `LiveDocumentationService.checkGroundedness`
 * + `mapGroundednessResponse`.
 *
 * Degrade-safe → fail-CLOSED:
 * - a transient blip is absorbed by a bounded retry (verdict comes from the clean re-check);
 * - a sustained outage / timeout / malformed response returns `unverified`;
 * - NO error path can ever return `grounded`.
 * PHI-safe logging: attempt counts + error names only — never clinical text.
 */
export class GuardrailGroundednessTool implements GroundednessToolExecutor {
  readonly key: LiveToolKey = 'groundedness';
  readonly name = GUARDRAIL_GROUNDEDNESS_TOOL;

  constructor(private readonly deps: GroundednessToolDeps) {}

  describe(): LiveToolDescriptor {
    return DESCRIPTORS.groundedness;
  }

  async execute(input: GroundednessToolInput, signal?: AbortSignal): Promise<LiveSummaryGroundednessDto> {
    const attempts = Math.max(1, this.deps.maxRetries + 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const token = (await this.deps.secretsService?.getSecretOptional('GUARDRAIL_SERVICE_TOKEN')) ?? '';
        const response = await this.deps.httpService.axiosRef.post(
          `${this.deps.guardrailServiceUrl}/api/guardrail/ground`,
          { summary: input.summary, transcript: input.sourceText },
          {
            timeout: this.deps.timeoutMs,
            headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
            signal,
          },
        );
        const verdict = mapGroundednessResponse(response.data);
        if (verdict) return verdict;
        this.deps.logger.warn({ message: 'Groundedness gate returned a malformed verdict — treating as unverified (fail-closed)', attempt });
      } catch (error) {
        this.deps.logger.warn({
          message: 'Groundedness gate call failed',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal?.aborted) break; // superseded — the flush drops this generation as stale
      if (attempt < attempts && this.deps.retryBackoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.deps.retryBackoffMs));
      }
    }
    // Fail-CLOSED: an unavailable/erroring gate marks the note `unverified` — the
    // clinician sees the text but knows it is unchecked; it is NEVER presented as verified.
    return { verdict: 'unverified', checkedAt: new Date().toISOString() };
  }
}

/**
 * Strict wire→DTO mapping for the guardrail `/guardrail/ground` response. Returns
 * `null` for a malformed body (→ fail-closed `unverified` upstream). Only the
 * literal `grounded` verdict string can mark a segment grounded, and only when the
 * service honestly reports `checked: true` — an errored/disabled gate response can
 * never roll up to `grounded`.
 */
export function mapGroundednessResponse(data: unknown): LiveSummaryGroundednessDto | null {
  const body = data as { segments?: unknown; flagged_spans?: unknown; checked?: unknown } | null | undefined;
  if (!body || !Array.isArray(body.segments)) return null;

  // A response we distrust (`checked !== true`: any
  // degrade / error / disabled path) must not drive ANY per-segment verdict, not just
  // the rollup. An honest degrade already sets every segment 'unverified'; this defends
  // against a compromised/buggy guardrail returning 'grounded' segments alongside
  // checked:false — a panel rendering per-segment marks would otherwise show segments as
  // verified from a response the mapper explicitly refused to trust. Only a `checked:true`
  // response may carry a non-'unverified' segment verdict.
  const trusted = body.checked === true;
  const segments: LiveSummaryGroundednessSegmentDto[] = body.segments.map((raw) => {
    const segment = raw as { text?: unknown; verdict?: unknown; score?: unknown; start?: unknown; end?: unknown };
    const verdict = !trusted
      ? 'unverified'
      : segment.verdict === 'grounded'
        ? 'grounded'
        : segment.verdict === 'ungrounded'
          ? 'ungrounded'
          : 'unverified';
    return {
      text: typeof segment.text === 'string' ? segment.text : '',
      verdict,
      score: typeof segment.score === 'number' ? segment.score : undefined,
      start: typeof segment.start === 'number' ? segment.start : undefined,
      end: typeof segment.end === 'number' ? segment.end : undefined,
    };
  });

  const flaggedSpans = Array.isArray(body.flagged_spans)
    ? body.flagged_spans
        .map((raw) => raw as { start?: unknown; end?: unknown })
        .filter((span) => typeof span.start === 'number' && typeof span.end === 'number')
        .map((span) => ({ start: span.start as number, end: span.end as number }))
    : [];

  const anyUngrounded = segments.some((segment) => segment.verdict === 'ungrounded');
  const anyUnverified = segments.some((segment) => segment.verdict === 'unverified');
  const verdict: LiveSummaryGroundednessDto['verdict'] = anyUngrounded
    ? 'ungrounded'
    : anyUnverified || segments.length === 0 || body.checked !== true
      ? 'unverified'
      : 'grounded';

  return { verdict, segments, flaggedSpans, checkedAt: new Date().toISOString() };
}

// =============================================================================
// Registry
// =============================================================================

export interface LiveToolRegistryDeps {
  nlp: NlpExtractionToolDeps;
  groundedness: GroundednessToolDeps;
  /**
   * The platform/env answer for each tool, used when a plan entry says
   * `enabled: null`. Pre-C4 behavior: ner/vitals always ran, groundedness ran
   * iff `LIVE_DOC_GROUNDEDNESS_ENABLED === 'true'`.
   */
  envDefaults: Record<LiveToolKey, boolean>;
}

/**
 * Maps {@link LiveToolKey}s to executors and answers "does this plan enable it?".
 *
 * Executors are constructed LAZILY and memoized: a plan that disables a tool
 * never constructs its executor, and a flush that runs the same tool twice
 * reuses one instance. The registry itself holds no per-flush state.
 */
export class LiveToolRegistry {
  private nlpTool?: ExtractionToolExecutor;
  private groundednessTool?: GroundednessToolExecutor;

  constructor(private readonly deps: LiveToolRegistryDeps) {}

  /**
   * The effective on/off for one tool under `plan`. `enabled: null` (or a key
   * the plan somehow lacks — read-side tolerance, the defense-in-depth mirror of
   * the 400 at write time) falls back to the env default, i.e. today's behavior.
   */
  isEnabled(plan: ResolvedToolPlan, key: LiveToolKey): boolean {
    const setting = plan?.tools?.[key];
    if (!setting || setting.enabled === null || setting.enabled === undefined) return this.deps.envDefaults[key];
    return setting.enabled;
  }

  /** The `nlp.classify-tokens` executor (serves BOTH the `ner` and `vitals` plan keys). */
  extraction(): ExtractionToolExecutor {
    this.nlpTool ??= new NlpExtractionTool(this.deps.nlp);
    return this.nlpTool;
  }

  /** The `guardrail.groundedness` executor. */
  guardrail(): GroundednessToolExecutor {
    this.groundednessTool ??= new GuardrailGroundednessTool(this.deps.groundedness);
    return this.groundednessTool;
  }

  /**
   * OD-5(a) seam. Static descriptors for every known tool — constructs nothing,
   * performs no I/O. When model-initiated tool-calling is eventually built, this
   * is what it serializes (filtered by the session's plan); today nothing in the
   * live path calls it, and no `tools` field is sent to SMR.
   */
  describeAll(plan?: ResolvedToolPlan): LiveToolDescriptor[] {
    return LIVE_TOOL_KEYS.filter((key) => (plan ? this.isEnabled(plan, key) : true)).map((key) => DESCRIPTORS[key]);
  }
}
