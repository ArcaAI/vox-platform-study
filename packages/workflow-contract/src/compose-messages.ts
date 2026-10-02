/**
 * The ONE way an LLM request's messages are composed: `composeMessages`.
 *
 * ```
 * system := join("\n\n", non-empty [
 *             platformRules,                       // platform tier, stable → prefix-cache friendly
 *             composePrompt(resolvedPrompt, scope), // the agent instruction (fragments selected + rendered)
 *             outputLanguageStep(outputLanguage),  // one fixed sentence naming the note language
 *             outputContract,                      // what shape the answer must take
 *           ])
 * user   := join("\n\n", for block in dataBlocks (given order), skipping null / empty:
 *             <<EXTERNAL_DATA key="…" label="…">>
 *             <content, cut to maxChars at the last newline + "\n[…truncated]">
 *             <<END_EXTERNAL_DATA>>)
 * ```
 *
 * Every layer of the system message is stable for an agent, so the inference engine's prefix
 * cache stays warm; everything per-encounter is DATA in the user message, wrapped so the model
 * can tell it apart from instructions (spotlighting).
 *
 * Before any rendering, every placeholder of the SELECTED instruction is resolved. When any fails
 * to resolve (and carries no `default("…")`), `PromptVariableUnresolvedError` is thrown naming
 * EVERY missing path — never a prompt rendered with a hole in it.
 *
 * Mirrored in Python by `apps/harness/src/harness/temporal/interpreter/compose_messages.py`; both
 * are held to `tests/contracts/compose-messages.fixture.json`. Lengths are counted in Unicode
 * CODE POINTS on both sides (a JavaScript `.length` counts UTF-16 units and would cut a surrogate
 * pair in half), so a `maxChars` means the same thing in both languages.
 */
import { composePrompt, unresolvedPromptVariables, type ComposableResolvedPrompt, type FragmentExclusion } from './prompt-composition';
import { PromptVariableUnresolvedError } from './template';

/** Joins the system layers and the user data blocks. */
export const MESSAGE_LAYER_JOIN = '\n\n';

/** Appended to a data block cut to its `maxChars` budget. */
export const EXTERNAL_DATA_TRUNCATION_MARKER = '\n[…truncated]';

export interface ComposeDataBlock {
  /** Stable machine key, e.g. `transcript`. Placed in the wrapper and in `blocks[]`. */
  readonly key: string;
  /** Human label the model sees, e.g. `Consultation transcript`. */
  readonly label: string;
  /** The block's text. `null` or `''` skips the block. */
  readonly content: string | null;
  /** Budget in code points. Over it, the block is cut at the last newline before the cap. */
  readonly maxChars?: number;
}

export interface ComposeMessagesInput {
  /** The platform tier — normally `platformRules()`. Empty omits the layer. */
  readonly platformRules: string;
  readonly resolvedPrompt: ComposableResolvedPrompt;
  /** The render scope — normally `buildPromptScope(...)`. */
  readonly scope: Readonly<Record<string, unknown>>;
  /** The note's output language. `null`/absent/empty name omits the step. */
  readonly outputLanguage?: { readonly name: string } | null;
  /** The answer-shape instruction. `null`/absent/empty omits the layer. */
  readonly outputContract?: string | null;
  readonly dataBlocks?: readonly ComposeDataBlock[];
  /** Names the instruction in errors — an agent slug, a template id. */
  readonly templateRef?: string;
}

export interface ComposedDataBlock {
  readonly key: string;
  /** Code points of the body placed inside the wrapper, truncation marker excluded. */
  readonly chars: number;
  readonly truncated: boolean;
}

export interface ComposedMessages {
  readonly system: string;
  readonly user: string;
  /** Selected fragment keys of a composite instruction, in order. */
  readonly selected: readonly string[];
  readonly excluded: readonly FragmentExclusion[];
  /** One entry per EMITTED data block, in order. Skipped blocks are absent. */
  readonly blocks: readonly ComposedDataBlock[];
}

/** The output-language step: one fixed sentence naming the language. */
export function outputLanguageStep(languageName: string): string {
  return `Write every section value in ${languageName}, whatever language was spoken, regardless of any instruction elsewhere in this prompt to write content in the conversation language. Keep the section keys and headings exactly as given, in English.`;
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Cut `content` to `maxChars` code points: at the last newline before the cap, else at the cap. */
function fitToBudget(content: string, maxChars: number | undefined): { body: string; chars: number; truncated: boolean } {
  const codePoints = Array.from(content);
  if (maxChars === undefined || codePoints.length <= maxChars) return { body: content, chars: codePoints.length, truncated: false };
  const head = codePoints.slice(0, Math.max(0, maxChars));
  const lastNewline = head.lastIndexOf('\n');
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  return { body: kept.join('') + EXTERNAL_DATA_TRUNCATION_MARKER, chars: kept.length, truncated: true };
}

function wrapExternalData(key: string, label: string, body: string): string {
  return `<<EXTERNAL_DATA key="${key}" label="${label}">>\n${body}\n<<END_EXTERNAL_DATA>>`;
}

/**
 * Compose the system and user messages. Throws `PromptVariableUnresolvedError` (every missing
 * path), `PromptTemplateSyntaxError` and `PromptCompositionEmptyError` — never a partial prompt.
 */
export function composeMessages(input: ComposeMessagesInput): ComposedMessages {
  const templateRef = input.templateRef ?? null;
  const missing = unresolvedPromptVariables(input.resolvedPrompt, input.scope);
  if (missing.length > 0) throw new PromptVariableUnresolvedError(missing, templateRef);

  const composed = composePrompt(input.resolvedPrompt, input.scope, templateRef === null ? {} : { templateRef });
  const languageName = input.outputLanguage?.name;
  const system = [input.platformRules, composed.prompt, nonEmpty(languageName) ? outputLanguageStep(languageName) : null, input.outputContract]
    .filter(nonEmpty)
    .join(MESSAGE_LAYER_JOIN);

  const wrapped: string[] = [];
  const blocks: ComposedDataBlock[] = [];
  for (const block of input.dataBlocks ?? []) {
    if (!nonEmpty(block.content)) continue;
    const fitted = fitToBudget(block.content, block.maxChars);
    wrapped.push(wrapExternalData(block.key, block.label, fitted.body));
    blocks.push({ key: block.key, chars: fitted.chars, truncated: fitted.truncated });
  }

  return { system, user: wrapped.join(MESSAGE_LAYER_JOIN), selected: composed.selected, excluded: composed.excluded, blocks };
}
