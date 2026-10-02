/**
 * The `generate/assembled` text-proxy prompt, through the ONE composer (`composeMessages`).
 *
 * The route used to send a governed template's RAW `content` as the system prompt — an
 * unrendered `{{…}}` reached the model verbatim — and the caller's context items as one
 * undelimited user prompt. Now the template is an inline resolved prompt rendered over the scope
 * this route can actually supply (the tenant's visit-type label), a reference it cannot supply is
 * a 400 naming every path, and each context item is a delimited data block.
 *
 * Lives in `@arcaai/applications` so the gateway controller composes through the contract
 * without a direct dependency on it.
 */
import { BadRequestException } from '@nestjs/common';
import {
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  buildPromptScope,
  composeMessages,
  platformRules,
  type ComposeDataBlock,
} from '@arcaai/workflow-contract';

export interface AssembledPromptBlock {
  /** Machine key, `^[a-z0-9_]+$`. */
  key: string;
  /** The label the model sees. */
  label: string;
  content: string;
}

export interface ComposeAssembledPromptInput {
  /** The governed template's body, or `null` for the platform's default instruction for `type`. */
  templateContent: string | null;
  /** Names the template in a refusal. */
  templateRef?: string;
  type: 'summary' | 'pre-summary';
  /** The tenant's own label for the visit type, when the caller named one. */
  visitLabel?: string | null;
  /** The clinician's effective DNA writing style, when one applies. */
  styleText?: string | null;
  blocks: readonly AssembledPromptBlock[];
}

const DEFAULT_INSTRUCTIONS: Readonly<Record<ComposeAssembledPromptInput['type'], string>> = {
  'pre-summary':
    'You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans.',
  summary: 'You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.',
};

/** Compose the system + user messages, or refuse with a named 400. */
export function composeAssembledPrompt(input: ComposeAssembledPromptInput): { system: string; user: string } {
  const typeLabel = input.type === 'pre-summary' ? 'pre-summary' : 'clinical summary';
  const outputContract = [
    input.styleText ? `Apply the following writing style:\n${input.styleText}` : null,
    // A LABELLED FIELD, not a sentence the label has to fit grammatically.
    input.visitLabel ? `Visit type: ${input.visitLabel}.` : null,
    `Generate a ${typeLabel} from the data sections.`,
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
  const templateRef = input.templateRef ?? 'text-proxy:assembled';
  try {
    return composeMessages({
      platformRules: platformRules(),
      resolvedPrompt: { source: 'inline', content: input.templateContent ?? DEFAULT_INSTRUCTIONS[input.type] },
      // The only value this route holds that a template may name.
      scope: buildPromptScope({ variables: input.visitLabel ? { visit_type: input.visitLabel } : {}, templateRef }),
      outputContract,
      dataBlocks: input.blocks.map((block): ComposeDataBlock => ({ key: block.key, label: block.label, content: block.content })),
      templateRef,
    });
  } catch (error) {
    if (error instanceof PromptVariableUnresolvedError) {
      throw new BadRequestException({
        message: `The prompt template references ${error.paths.map((path) => `\`${path}\``).join(', ')}, which this route cannot supply. Give the placeholders a \`default("…")\`, or generate through the consultation summary instead.`,
        code: 'PROMPT_VARIABLE_UNRESOLVED',
        path: error.path,
        missingVariables: [...error.paths],
      });
    }
    if (error instanceof PromptTemplateSyntaxError) {
      throw new BadRequestException({ message: 'The prompt template is not a valid template.', code: 'PROMPT_TEMPLATE_SYNTAX', detail: error.message });
    }
    throw error;
  }
}
