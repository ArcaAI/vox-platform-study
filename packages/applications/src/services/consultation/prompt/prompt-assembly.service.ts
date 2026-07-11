/**
 * PromptAssemblyService
 *
 * Assembles a complete SMR v2 payload by:
 * 1. Resolving the prompt template via PromptResolutionService
 * 2. Loading template content + hyperparameters + JSON schema from DB
 * 3. Substituting variables ({conversation_language}, {style_DNA_*}, etc.)
 * 4. Building the final payload with all parameters for SMR v2
 *
 * Implements E2 of TASK-222: Wire Variable Substitution.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptResolutionService, PromptResolutionTier } from './prompt-resolution.service';
import { PromptTemplateRepository, DnaWritingStyleReportRepository } from '@arcaai/domains';

const VARIABLE_PATTERN = /\{([a-zA-Z_][\w-]*)\}/g;

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
 * TASK-462 C5-03 — the ontology codes (umls/snomed/rxnorm/icd/loinc) are READ
 * here but WRITTEN nowhere until the SOTA Theme C clinical NER + ontology linker
 * lands (TASK-476); today the code set is permanently empty. The groundedness
 * guard below therefore emits an explicit "no codes present" note when the whole
 * entity set is un-coded, so the block never reads as if coding was attempted.
 * The guard disengages automatically once the linker starts populating codes.
 */
// TASK-462 M-3 — this note is injected into the clinical LLM prompt on EVERY
// NER-bearing summary today (the code set is permanently empty), so it must be
// clinically NEUTRAL: no internal jargon or ticket ids (which the model could
// echo into a patient's summary). The SOTA Theme C / TASK-476 pointer lives in
// the doc comment above (code only), never in the prompt string.
const NER_NO_ONTOLOGY_CODES_NOTE = '(no standardized codes assigned)';

function serializeNerEntities(entities: NerEntityForPrompt[]): string {
  if (!entities?.length) {
    return '';
  }

  // TASK-462 C5-03 groundedness guard — does ANY entity carry an ontology code?
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
 * into a compact block — one entry per line, blanks dropped. TASK-342 GAP #2.
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
 * A NER entity flattened for prompt injection (TASK-330 Phase 1).
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
  departmentId?: string;
  promptType?: 'pre-summary' | 'new-patient' | 'revisit';
  transcript: string;
  conversationLanguage: string;
  dnaStyleId?: string;
  preSummaryText?: string;
  sameDayPrequelSummary?: string;
  explicitTemplate?: string;
  /** The requesting doctor's preferred prompt template id (TASK-329 P2 Tier-0). */
  preferredPromptTemplateId?: string | null;
  /**
   * TASK-330 Phase 1 — clinical NER entities for the consultation transcript.
   * Serialised into the {ner_entities} variable and/or appended to the prompt
   * so NER output actually reaches the LLM.
   */
  nerEntities?: NerEntityForPrompt[];
  /**
   * TASK-342 GAP #2 — the doctor's case-notes / work-notes for the consultation
   * (each entry already labeled by the caller, e.g. `[case note] …`). Serialised
   * into {clinician_notes} and/or appended so they reach the authoritative SOAP.
   */
  clinicianNotes?: string[];
  /**
   * TASK-342 GAP #2 — uploaded lab/exam attachment contents (extracted text when
   * available, else the filename label). Serialised into {attachments} and/or
   * appended to the prompt.
   */
  attachments?: string[];
  /**
   * TASK-344 Workstream B — the doctor's manual highlight spans for the
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
   * The prompt registry id that was actually resolved/used (TASK-331 doc-06 F4).
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

  // TASK-355 Phase C (R-6) — warm-start kill-switch (HARNESS_WARM_START_ENABLED,
  // default OFF). Load-bearing gate: when OFF the {pre_summary_text} append-fallback
  // below does not fire, so neither the harness path nor the legacy
  // SummaryService.generateSummary() path injects a prior draft (the legacy latent
  // no-op is preserved). Cached at construction, matching live-documentation/ocr.
  private readonly warmStartEnabled: boolean;

  constructor(
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
    private readonly configService: ConfigService,
  ) {
    const raw = String(this.configService.get('HARNESS_WARM_START_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    this.warmStartEnabled = raw === 'true' || raw === '1';
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

    if (!userPrompt.includes(params.transcript)) {
      userPrompt += `\n\n--- TRANSCRIPT ---\n${params.transcript}`;
    }

    // TASK-330 Phase 1 — guarantee NER reaches the LLM. If the template
    // consumed {ner_entities} the block is already present; otherwise append it.
    const nerBlock = variables.ner_entities ?? '';
    if (nerBlock && !userPrompt.includes(nerBlock)) {
      userPrompt += `\n\n--- RECOGNIZED CLINICAL ENTITIES (from NER) ---\n${nerBlock}`;
    }

    // TASK-342 GAP #2 — fold the doctor's case/work notes and attachment
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

    // TASK-344 Workstream B — fold the doctor's manually highlighted spans into
    // the authoritative-SOAP prompt. Same pattern as NER / clinician notes: if
    // the template consumed {doctor_highlights} the block is already present,
    // else append it under a labeled section.
    const highlightsBlock = variables.doctor_highlights ?? '';
    if (highlightsBlock && !userPrompt.includes(highlightsBlock)) {
      userPrompt += `\n\n--- DOCTOR HIGHLIGHTS (clinician-flagged spans) ---\n${highlightsBlock}`;
    }

    // TASK-355 Phase C (R-6) → TASK-480 Half-A — warm-start refinement, gated behind the
    // kill-switch (default OFF). Matured into the explicit two-stage scratchpad→final
    // lineage the SOTA S3-F5 verdict names: the live session's running note is STAGE 1
    // (a working SCRATCHPAD), the harness produces STAGE 2 (the FINAL note) by REFINING
    // that scratchpad — never regenerating cold. If the template consumed
    // {pre_summary_text} the block is already present; otherwise append it (the seed
    // templates declare the variable but never inline the placeholder, so without this
    // fallback the snapshot silently never reaches the LLM). The transcript stays
    // authoritative: on a scratchpad↔transcript conflict the model follows the transcript.
    // When the flag is OFF this block does not fire, restoring exact pre-Phase-C behavior
    // on the harness AND legacy paths.
    if (this.warmStartEnabled) {
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
      // TASK-330 Phase 1 — always define {ner_entities} (empty when none) so
      // templates referencing it never leave a literal placeholder behind.
      ner_entities: serializeNerEntities(params.nerEntities ?? []),
      // TASK-342 GAP #2 — always define the notes/attachments variables (empty
      // when none) so templates referencing them never leave a placeholder.
      clinician_notes: serializeTextBlock(params.clinicianNotes),
      attachments: serializeTextBlock(params.attachments),
      // TASK-344 Workstream B — always define {doctor_highlights} (empty when
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
