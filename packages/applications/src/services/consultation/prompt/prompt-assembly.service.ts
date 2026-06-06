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
 */
function serializeNerEntities(entities: NerEntityForPrompt[]): string {
  if (!entities?.length) {
    return '';
  }

  return entities
    .map((entity) => {
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
    })
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

  constructor(
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
  ) {}

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
