/**
 * PromptAssemblyService
 *
 * Assembles a complete SMR v2 payload by:
 * 1. Resolving the prompt template via PromptResolutionService
 * 2. Loading template content + hyperparameters + JSON schema from DB
 * 3. Substituting variables ({conversation_language}, {style_DNA_*}, etc.)
 * 4. Building the final payload with all parameters for SMR v2
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PromptResolutionService, PromptResolutionTier } from './prompt-resolution.service';
import { PromptTemplateRepository, DnaWritingStyleReportRepository } from '@arcaai/domains';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { IGateEditExemplarRetriever } from '../../gate-edit-mining/IGateEditExemplarRetriever';
import { IActiveUserContext } from '../../../interfaces';

const VARIABLE_PATTERN = /\{([a-zA-Z_][\w-]*)\}/g;

/**
 * How many approved notes are shown as style examples.
 *
 * Small on purpose: each exemplar is a whole clinical note, so the block costs
 * real prompt budget, and few-shot returns diminish quickly. The mining service
 * caps this independently — this is the prompt side's own ceiling.
 */
const FEW_SHOT_EXEMPLAR_LIMIT = 3;

/**
 * Stable 32-bit fingerprint of the exemplar set, used only to VERSION the
 * few-shot block. It lets a cached prefix be attributed to a known exemplar set
 * (and makes a set change visible in logs) without embedding row ids — which
 * would leak which encounters were mined.
 */
function fingerprintExemplarSet(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) => {
    return name in variables ? variables[name] : match;
  });
}

/**
 * Serialises NER entities into a compact, LLM-friendly block.
 *
 * One line per entity:
 *   `- <label> (<TYPE>) [umls:..; snomed:..; rxnorm:..; icd:..; loinc:..] @<start>-<end>`
 *
 * The label prefers the normalized form when available. Codes and offsets are
 * only emitted when present, keeping the block dense and deterministic.
 *
 * The ontology codes (umls/snomed/rxnorm/icd/loinc) are READ
 * here but WRITTEN nowhere until the SOTA Theme C clinical NER + ontology linker
 * lands; today the code set is permanently empty. The groundedness
 * guard below therefore emits an explicit "no codes present" note when the whole
 * entity set is un-coded, so the block never reads as if coding was attempted.
 * The guard disengages automatically once the linker starts populating codes.
 */
// This note is injected into the clinical LLM prompt on EVERY
// NER-bearing summary today (the code set is permanently empty), so it must be
// clinically NEUTRAL: no internal jargon or ticket ids (which the model could
// echo into a patient's summary) — those stay in the doc comment above
// (code only), never in the prompt string.
const NER_NO_ONTOLOGY_CODES_NOTE = '(no standardized codes assigned)';

function serializeNerEntities(entities: NerEntityForPrompt[]): string {
  if (!entities?.length) {
    return '';
  }

  // Groundedness guard — does ANY entity carry an ontology code?
  const hasAnyOntologyCode = entities.some(
    (entity) => entity.umlsCui || entity.snomedCode || entity.rxnormCode || entity.icdCode || entity.loincCode,
  );

  const lines = entities.map((entity) => {
    const label = entity.normalizedText && entity.normalizedText.trim().length > 0 ? entity.normalizedText : entity.text;

    const codeParts: string[] = [];
    if (entity.umlsCui) codeParts.push(`umls:${entity.umlsCui}`);
    if (entity.snomedCode) codeParts.push(`snomed:${entity.snomedCode}`);
    if (entity.rxnormCode) codeParts.push(`rxnorm:${entity.rxnormCode}`);
    if (entity.icdCode) codeParts.push(`icd:${entity.icdCode}`);
    if (entity.loincCode) codeParts.push(`loinc:${entity.loincCode}`);
    const codes = codeParts.length > 0 ? ` [${codeParts.join('; ')}]` : '';

    const span = entity.startOffset != null && entity.endOffset != null ? ` @${entity.startOffset}-${entity.endOffset}` : '';

    return `- ${label} (${entity.type})${codes}${span}`;
  });

  // Make "no codes present" EXPLICIT rather than silently emitting un-coded lines
  // that could read as if ontology coding had been performed.
  if (!hasAnyOntologyCode) {
    lines.push(NER_NO_ONTOLOGY_CODES_NOTE);
  }

  return lines.join('\n');
}

/**
 * Serialises a list of free-text items (clinician notes / attachment contents)
 * into a compact block — one entry per line, blanks dropped.
 */
function serializeTextBlock(items?: string[]): string {
  if (!items?.length) {
    return '';
  }
  return items
    .map((item) => item?.trim())
    .filter((item): item is string => !!item)
    .join('\n');
}

// ============================================================================
// Types
// ============================================================================

/**
 * A NER entity flattened for prompt injection.
 * Mapped from NamedEntityEntity by the SummaryProcessor; codes/offsets optional.
 */
export interface NerEntityForPrompt {
  text: string;
  type: string;
  normalizedText?: string | null;
  umlsCui?: string | null;
  snomedCode?: string | null;
  rxnormCode?: string | null;
  icdCode?: string | null;
  loincCode?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
}

export interface PromptAssemblyParams {
  /**
   * Tenant whose effective `HarnessPolicy.warmStartEnabled` governs
   * the prior-draft injection below. Optional: callers running inside a CLS context
   * (API request, harness worker, BullMQ processor) may omit it and the tenant is
   * read from CLS; absent both, the SYSTEM/global default policy applies.
   */
  tenantId?: string;
  departmentId?: string;
  promptType?: 'pre-summary' | 'new-patient' | 'revisit';
  transcript: string;
  conversationLanguage: string;
  dnaStyleId?: string;
  preSummaryText?: string;
  sameDayPrequelSummary?: string;
  explicitTemplate?: string;
  /** The requesting doctor's preferred prompt template id. */
  preferredPromptTemplateId?: string | null;
  /**
   * Clinical NER entities for the consultation transcript.
   * Serialised into the {ner_entities} variable and/or appended to the prompt
   * so NER output actually reaches the LLM.
   */
  nerEntities?: NerEntityForPrompt[];
  /**
   * The doctor's case-notes / work-notes for the consultation
   * (each entry already labeled by the caller, e.g. `[case note] …`). Serialised
   * into {clinician_notes} and/or appended so they reach the authoritative SOAP.
   */
  clinicianNotes?: string[];
  /**
   * Uploaded lab/exam attachment contents (extracted text when
   * available, else the filename label). Serialised into {attachments} and/or
   * appended to the prompt.
   */
  attachments?: string[];
  /**
   * The doctor's manual highlight spans for the
   * consultation (each entry already labeled by the caller, e.g. `[highlight] …`).
   * Serialised into {doctor_highlights} and/or appended so the clinician-flagged
   * spans reach the authoritative SOAP. A SEPARATE concern from NER entities.
   */
  highlights?: string[];
}

export interface AssembledPrompt {
  userPrompt: string;
  systemPrompt: string;
  hyperparameters: Record<string, number>;
  responseFormat: { type: string; json_schema: Record<string, unknown>; strict: boolean } | null;
  resolvedFrom: PromptResolutionTier;
  /**
   * The prompt registry id that was actually resolved/used.
   * Optional so existing inline AssembledPrompt literals remain valid; the real
   * PromptAssemblyService.assemble() always populates it from the resolver.
   */
  promptId?: string;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class PromptAssemblyService {
  private readonly logger = new Logger(PromptAssemblyService.name);

  // Warm-start kill-switch. Load-bearing gate: when OFF the
  // {pre_summary_text} append-fallback below does not fire, so neither the harness
  // path nor the legacy SummaryService.generateSummary() path injects a prior draft
  // (the legacy latent no-op is preserved).
  //
  // The AUTHORITY is now `HarnessPolicy.warmStartEnabled`, resolved
  // PER CALL. It used to be this env var alone, cached at construction: the policy
  // column was write-plumbed all the way to the admin console and read by nothing,
  // so the knob was dead and the real switch needed a redeploy to move and could
  // never vary per tenant. The env var is retained ONLY as the fallback for a null
  // policy value, which reproduces the original env-only behaviour byte-for-byte.
  private readonly warmStartEnvFallback: boolean;

  constructor(
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
    private readonly configService: ConfigService,
    // Optional + trailing so existing positional test fixtures keep their arity;
    // production DI (ConsultationServiceModule) always supplies both. Absent ⇒ the
    // env fallback governs, i.e. exactly the original env-only behaviour.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    @Optional() @Inject(ClsService) private readonly cls?: ClsService<IActiveUserContext>,
    // The gate-edit learning loop's READ half. Optional and
    // trailing for the same reason as the two above: absent ⇒ zero-shot, which
    // is exactly the pre-B6 prompt.
    @Optional() @Inject(IGateEditExemplarRetriever) private readonly exemplarRetriever?: IGateEditExemplarRetriever,
  ) {
    const raw = String(this.configService.get('HARNESS_WARM_START_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    this.warmStartEnvFallback = raw === 'true' || raw === '1';
  }

  /**
   * Effective warm-start decision for the calling tenant.
   *
   * Policy wins; a null policy value means "not configured" and falls through to the
   * env fallback. Resolved on every call so a global admin's console flip takes
   * effect without a redeploy. A policy-backend failure degrades to the env value —
   * prompt assembly is on the generation hot path and must never fail closed on a
   * governance lookup.
   */
  private async resolveWarmStartEnabled(tenantId?: string): Promise<boolean> {
    if (!this.harnessPolicyService) {
      return this.warmStartEnvFallback;
    }
    try {
      const effective = await this.harnessPolicyService.getEffectivePolicy(tenantId ?? this.cls?.get('tenantId'));
      return effective.warmStartEnabled ?? this.warmStartEnvFallback;
    } catch (error) {
      this.logger.warn({
        message: 'Harness policy lookup failed while resolving warmStartEnabled — falling back to env',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.warmStartEnvFallback;
    }
  }

  /**
   * The few-shot style block, or `''` when there is nothing to add.
   *
   * Three properties this method must never lose:
   *
   *  * **Silent degradation.** No retriever, no tenant, no rows, or a throwing
   *    store all return `''`. A learning-loop outage must not become a
   *    generation outage (§3.4).
   *  * **Redacted text only.** `redactedAfter` is the sole field read; it is the
   *    only one the mining store guarantees is PHI-free.
   *  * **Framed as style, not history.** The notes belong to OTHER encounters,
   *    so the header says so explicitly — an unlabelled block is a fabrication
   *    vector, since the model would be free to read another patient's findings
   *    as this patient's.
   */
  private async buildFewShotExemplarBlock(params: PromptAssemblyParams): Promise<string> {
    if (!this.exemplarRetriever) return '';

    const tenantId = params.tenantId ?? this.cls?.get('tenantId');
    if (!tenantId) return '';

    let rows;
    try {
      rows = await this.exemplarRetriever.retrieveExemplars({
        tenantId,
        departmentId: params.departmentId ?? null,
        limit: FEW_SHOT_EXEMPLAR_LIMIT,
      });
    } catch (error) {
      this.logger.warn(
        `Gate-edit exemplar retrieval failed; falling back to a zero-shot prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }

    const snippets = (rows ?? [])
      .map((row) => row?.redactedAfter?.trim())
      .filter((snippet): snippet is string => !!snippet)
      .slice(0, FEW_SHOT_EXEMPLAR_LIMIT);

    if (snippets.length === 0) return '';

    const version = fingerprintExemplarSet(snippets.join(' '));

    return (
      `\n\n--- STYLE REFERENCE — APPROVED NOTES FROM DIFFERENT PATIENTS (set ${version}) ---\n` +
      `The notes below were written for OTHER patients and are included ONLY as a ` +
      `reference for house formatting, section order and tone. They are NOT this ` +
      `patient's history: never carry a clinical fact, finding, or medication across ` +
      `from them.\n\n${snippets.join('\n\n- - -\n\n')}`
    );
  }

  async assemble(params: PromptAssemblyParams): Promise<AssembledPrompt> {
    const resolved = await this.promptResolutionService.resolve({
      departmentId: params.departmentId,
      promptType: params.promptType,
      explicitTemplate: params.explicitTemplate,
      preferredPromptTemplateId: params.preferredPromptTemplateId,
    });

    const template = resolved.promptId ? await this.promptTemplateRepository.findById(resolved.promptId) : null;

    const variables = await this.buildVariables(params);

    let userPrompt: string;
    if (template?.content) {
      userPrompt = substituteVariables(template.content, variables);
    } else {
      userPrompt = params.transcript;
    }

    // Per-department few-shot exemplars, placed with the
    // template content and BEFORE the per-encounter transcript so the engine's
    // prefix cache still hits across flushes (§3.4). Empty string when there is
    // nothing to show, so the zero-shot prompt stays byte-identical.
    userPrompt += await this.buildFewShotExemplarBlock(params);

    if (!userPrompt.includes(params.transcript)) {
      userPrompt += `\n\n--- TRANSCRIPT ---\n${params.transcript}`;
    }

    // Guarantee NER reaches the LLM. If the template
    // consumed {ner_entities} the block is already present; otherwise append it.
    const nerBlock = variables.ner_entities ?? '';
    if (nerBlock && !userPrompt.includes(nerBlock)) {
      userPrompt += `\n\n--- RECOGNIZED CLINICAL ENTITIES (from NER) ---\n${nerBlock}`;
    }

    // Fold the doctor's case/work notes and attachment
    // contents into the authoritative-SOAP prompt. Same pattern as NER: if the
    // template consumed the placeholder the block is already present, else append.
    const clinicianNotesBlock = variables.clinician_notes ?? '';
    if (clinicianNotesBlock && !userPrompt.includes(clinicianNotesBlock)) {
      userPrompt += `\n\n--- CLINICIAN NOTES (case / work notes) ---\n${clinicianNotesBlock}`;
    }

    const attachmentsBlock = variables.attachments ?? '';
    if (attachmentsBlock && !userPrompt.includes(attachmentsBlock)) {
      userPrompt += `\n\n--- ATTACHMENTS (lab / exam results) ---\n${attachmentsBlock}`;
    }

    // Fold the doctor's manually highlighted spans into
    // the authoritative-SOAP prompt. Same pattern as NER / clinician notes: if
    // the template consumed {doctor_highlights} the block is already present,
    // else append it under a labeled section.
    const highlightsBlock = variables.doctor_highlights ?? '';
    if (highlightsBlock && !userPrompt.includes(highlightsBlock)) {
      userPrompt += `\n\n--- DOCTOR HIGHLIGHTS (clinician-flagged spans) ---\n${highlightsBlock}`;
    }

    // Warm-start refinement, gated behind the
    // kill-switch (default OFF). Matured into the explicit two-stage scratchpad→final
    // lineage: the live session's running note is STAGE 1
    // (a working SCRATCHPAD), the harness produces STAGE 2 (the FINAL note) by REFINING
    // that scratchpad — never regenerating cold. If the template consumed
    // {pre_summary_text} the block is already present; otherwise append it (the seed
    // templates declare the variable but never inline the placeholder, so without this
    // fallback the snapshot silently never reaches the LLM). The transcript stays
    // authoritative: on a scratchpad↔transcript conflict the model follows the transcript.
    // When the flag is OFF this block does not fire, restoring exact pre-Phase-C behavior
    // on the harness AND legacy paths.
    if (await this.resolveWarmStartEnabled(params.tenantId)) {
      const preSummaryBlock = variables.pre_summary_text ?? '';
      if (preSummaryBlock && !userPrompt.includes(preSummaryBlock)) {
        userPrompt +=
          `\n\n--- PRIOR DRAFT (running SOAP note from the live session — STAGE 1 SCRATCHPAD) ---\n` +
          `${preSummaryBlock}\n\n` +
          `INSTRUCTION (two-stage lineage — refine the STAGE 1 SCRATCHPAD into the STAGE 2 FINAL note): ` +
          `Refine and correct the PRIOR DRAFT above into the final note. ` +
          `Do not regenerate from scratch — preserve correct content and revise only where ` +
          `the transcript, recognized entities, or clinician notes indicate. ` +
          `The full transcript remains the single source of truth; if the prior draft ` +
          `conflicts with the transcript, follow the transcript.`;
      }
    }

    const promptConfig = this.extractPromptConfig(template);
    const hyperparameters = promptConfig?.hyperparameters ?? {};
    const outputSchema = promptConfig?.outputSchema ?? null;

    const responseFormat = outputSchema ? { type: 'json_schema' as const, json_schema: outputSchema, strict: true } : null;

    const systemPrompt = 'You are a medical scribe AI assistant.';

    this.logger.debug({
      message: 'Prompt assembled',
      resolvedFrom: resolved.resolvedFrom,
      templateId: template?.id ?? null,
      hasSchema: !!outputSchema,
      hyperparameters,
    });

    return {
      userPrompt,
      systemPrompt,
      hyperparameters,
      responseFormat,
      resolvedFrom: resolved.resolvedFrom,
      promptId: resolved.promptId,
    };
  }

  private async buildVariables(params: PromptAssemblyParams): Promise<Record<string, string>> {
    const variables: Record<string, string> = {
      conversation_language: params.conversationLanguage,
      // Always define {ner_entities} (empty when none) so
      // templates referencing it never leave a literal placeholder behind.
      ner_entities: serializeNerEntities(params.nerEntities ?? []),
      // Always define the notes/attachments variables (empty
      // when none) so templates referencing them never leave a placeholder.
      clinician_notes: serializeTextBlock(params.clinicianNotes),
      attachments: serializeTextBlock(params.attachments),
      // Always define {doctor_highlights} (empty when
      // none) so templates referencing it never leave a literal placeholder.
      doctor_highlights: serializeTextBlock(params.highlights),
    };

    if (params.preSummaryText) {
      variables.pre_summary_text = params.preSummaryText;
    }

    if (params.sameDayPrequelSummary) {
      variables.same_day_prequel_summary = params.sameDayPrequelSummary;
    }

    if (params.dnaStyleId) {
      const dnaStyle = await this.dnaWritingStyleRepository.findById(params.dnaStyleId);
      if (dnaStyle?.styleText) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const dnaVarPattern = /style_DNA_[\w-]+/;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const allVarNames = Object.keys(variables);
        for (const key of this.getDnaVariableKeys()) {
          variables[key] = dnaStyle.styleText;
        }
      }
    }

    return variables;
  }

  private getDnaVariableKeys(): string[] {
    return [
      'style_DNA_doctor_department_surgery',
      'style_DNA_doctor_department_medicine',
      'style_DNA_doctor_department_neurology',
      'style_DNA_doctor_department_orthopedics',
      'style_DNA_doctor_department_hematology',
      'style_DNA_doctor_department_rheumatology',
      'style_DNA_doctor_department_dermatology',
      'style_DNA_doctor_department_dietetics',
      'style_DNA_doctor_department_nephrology',
      'style_DNA_doctor_department_surgical_oncology',
      'style_DNA_doctor_department_breast_endocrine',
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractPromptConfig(template: any): {
    hyperparameters?: Record<string, number>;
    outputSchema?: Record<string, unknown>;
  } | null {
    if (!template?.metaData) return null;

    const metaData = template.metaData as Record<string, unknown>;
    const promptConfig = metaData.promptConfig as Record<string, unknown> | undefined;
    if (!promptConfig) return null;

    return {
      hyperparameters: (promptConfig.hyperparameters as Record<string, number>) ?? undefined,
      outputSchema: (promptConfig.outputSchema as Record<string, unknown>) ?? undefined,
    };
  }
}
