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
import { PromptResolutionService, ResolvedPromptConfig, PromptResolutionTier } from './prompt-resolution.service';
import { PromptTemplateRepository, DnaWritingStyleReportRepository } from '@arcaai/domains';

const VARIABLE_PATTERN = /\{([a-zA-Z_][\w-]*)\}/g;

function substituteVariables(template: string, variables: Record<string, string>): string {
    return template.replace(VARIABLE_PATTERN, (match, name: string) => {
        return name in variables ? variables[name] : match;
    });
}

// ============================================================================
// Types
// ============================================================================

export interface PromptAssemblyParams {
    departmentId?: string;
    promptType?: 'pre-summary' | 'new-patient' | 'revisit';
    transcript: string;
    conversationLanguage: string;
    dnaStyleId?: string;
    preSummaryText?: string;
    sameDayPrequelSummary?: string;
    explicitTemplate?: string;
}

export interface AssembledPrompt {
    userPrompt: string;
    systemPrompt: string;
    hyperparameters: Record<string, number>;
    responseFormat: { type: string; json_schema: Record<string, unknown>; strict: boolean } | null;
    resolvedFrom: PromptResolutionTier;
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
        });

        const template = resolved.promptId
            ? await this.promptTemplateRepository.findById(resolved.promptId)
            : null;

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

        const promptConfig = this.extractPromptConfig(template);
        const hyperparameters = promptConfig?.hyperparameters ?? {};
        const outputSchema = promptConfig?.outputSchema ?? null;

        const responseFormat = outputSchema
            ? { type: 'json_schema' as const, json_schema: outputSchema, strict: true }
            : null;

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
        };
    }

    private async buildVariables(params: PromptAssemblyParams): Promise<Record<string, string>> {
        const variables: Record<string, string> = {
            conversation_language: params.conversationLanguage,
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
                const dnaVarPattern = /style_DNA_[\w-]+/;
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
