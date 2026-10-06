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
 *
 * TASK-1047 D1 — the visit label and the clinician's style are RUNTIME values, so they are data
 * blocks (`visit_type`, `style_reference`); the system message is the platform rules, the template
 * (its `{{visit_type}}` a pointer, FC-1) and STATIC keyed contract parts. The composed `governance`
 * and the platform pieces are returned for the caller's egress hint (FC-4).
 */
import { BadRequestException } from '@nestjs/common';
import {
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  buildPromptScope,
  composeMessages,
  platformRules,
  type ComposeDataBlock,
  type SystemGovernance,
} from '@arcaai/workflow-contract';
import type { GovernedPieceInput } from '../governed-prompt/IGovernedPromptRegistry';
import { DNA_STYLE_GUIDANCE, STYLE_REFERENCE_BLOCK, styleReferenceContent } from '../consultation/prompt/style-reference';
import { platformPiecesOf, type OutputContractPart } from './system-governance';

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

/** What the route sends: the messages, plus the FC-4 egress hint's two halves. */
export interface ComposedAssembledPrompt {
  system: string;
  user: string;
  /** The composer's governance of `system` (FC-2); hand it to the egress as `systemGovernance`. */
  governance?: SystemGovernance;
  /** The PLATFORM / CONTRACT pieces this composer emitted, for background registration (FC-3). */
  platformPieces: GovernedPieceInput[];
}

/** The visit label's block: a RUNTIME value (any label a tenant defines), so data. */
const VISIT_TYPE_BLOCK = { key: 'visit_type', label: 'VISIT TYPE' } as const;

/** Compose the system + user messages, or refuse with a named 400. */
export function composeAssembledPrompt(input: ComposeAssembledPromptInput): ComposedAssembledPrompt {
  const typeLabel = input.type === 'pre-summary' ? 'pre-summary' : 'clinical summary';
  // STATIC parts only: `typeLabel` is one of two platform constants.
  const contractParts: OutputContractPart[] = [
    ...(input.styleText ? [{ key: 'dna-style', text: DNA_STYLE_GUIDANCE }] : []),
    { key: 'assembled-task', text: `Generate a ${typeLabel} from the data sections.` },
  ];
  const style = styleReferenceContent({ style: input.styleText });
  const templateRef = input.templateRef ?? 'text-proxy:assembled';
  try {
    const composed = composeMessages({
      platformRules: platformRules(),
      resolvedPrompt: { source: 'inline', content: input.templateContent ?? DEFAULT_INSTRUCTIONS[input.type] },
      // The only value this route holds that a template may name — rendered as a pointer to its block.
      scope: buildPromptScope({ variables: input.visitLabel ? { visit_type: input.visitLabel } : {}, templateRef }),
      outputContractParts: contractParts,
      // Stable first (D9): the doctor's style, the visit label, then the caller's items in order.
      dataBlocks: [
        ...(style ? [{ key: STYLE_REFERENCE_BLOCK.key, label: STYLE_REFERENCE_BLOCK.label, content: style }] : []),
        ...(input.visitLabel ? [{ key: VISIT_TYPE_BLOCK.key, label: VISIT_TYPE_BLOCK.label, content: input.visitLabel }] : []),
        ...input.blocks.map((block): ComposeDataBlock => ({ key: block.key, label: block.label, content: block.content })),
      ],
      templateRef,
    });
    return {
      system: composed.system,
      user: composed.user,
      ...(composed.governance ? { governance: composed.governance } : {}),
      platformPieces: platformPiecesOf({ platformRules: platformRules(), contractParts }),
    };
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
      throw new BadRequestException({
        message: 'The prompt template is not a valid template.',
        code: 'PROMPT_TEMPLATE_SYNTAX',
        detail: error.message,
      });
    }
    throw error;
  }
}
