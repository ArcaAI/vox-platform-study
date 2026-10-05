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
 *             <<<EXTERNAL_DATA section="<key>">>>
 *             --- <label> ---
 *             <content, cut to maxChars at the last newline + "\n[…truncated]", markers neutralised>
 *             <<<END_EXTERNAL_DATA>>>)
 * ```
 *
 * Every layer of the system message is stable for an agent, so the inference engine's prefix
 * cache stays warm; everything per-encounter is DATA in the user message, wrapped so the model
 * can tell it apart from instructions (spotlighting).
 *
 * The wrapper is the one `platformRules()` describes ("Trust the delimiters"), so it must not be
 * forgeable from inside a block: a `key` must match `^[a-z0-9_]+$` (`ComposeDataBlockKeyError`
 * otherwise), a `label` is flattened to one line with `"` and `<`/`>` removed, and any start or end
 * marker in the body — case-insensitive, whitespace tolerated inside it — is replaced with
 * `[external-data marker removed]` after truncation.
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

/** What an injected `<<<EXTERNAL_DATA` / `<<<END_EXTERNAL_DATA>>>` marker in a body becomes. */
export const EXTERNAL_DATA_MARKER_REPLACEMENT = '[external-data marker removed]';

/** The grammar of a data block `key` — it is placed verbatim inside the start marker. */
export const COMPOSE_DATA_BLOCK_KEY_PATTERN = /^[a-z0-9_]+$/;

/**
 * Start (`<<<EXTERNAL_DATA`) or end (`<<<END_EXTERNAL_DATA>>>`, the closing `>>>` optional) marker,
 * case-insensitive, with spaces / tabs / newlines tolerated between its characters. The whitespace
 * class is spelled out rather than `\s` so the Python mirror matches the very same characters.
 */
const EXTERNAL_DATA_MARKER =
  /<[ \t\r\n]*<[ \t\r\n]*<[ \t\r\n]*(?:END[ \t\r\n]*_[ \t\r\n]*)?EXTERNAL[ \t\r\n]*_[ \t\r\n]*DATA(?:[ \t\r\n]*>[ \t\r\n]*>[ \t\r\n]*>)?/gi;

/** A data block's `key` is not `^[a-z0-9_]+$`. */
export class ComposeDataBlockKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Data block key ${JSON.stringify(key)} must match ^[a-z0-9_]+$.`);
    this.name = 'ComposeDataBlockKeyError';
    this.key = key;
  }
}

export interface ComposeDataBlock {
  /** Stable machine key, e.g. `transcript` (`^[a-z0-9_]+$`). Placed in the start marker and in `blocks[]`. */
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
  /**
   * TASK-1036 OD-10 — also drop a block whose content is only spaces, tabs, CR and LF (the
   * whitespace class is spelled out, as for the markers, so the Python mirror matches the same
   * characters). Default `false`: today's bytes, where only `null` / `''` content is skipped. A
   * dropped block is absent from `blocks[]`, like a skipped one.
   */
  readonly dropEmptyBlocks?: boolean;
}

/** OD-10 — content a `dropEmptyBlocks` compose treats as empty. */
const BLANK_CONTENT = /^[ \t\r\n]*$/;

export interface ComposedDataBlock {
  readonly key: string;
  /** Code points of the content kept within the budget, before marker neutralisation and the truncation marker. */
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
function fitToBudget(content: string, maxChars: number | undefined): { kept: string; chars: number; truncated: boolean } {
  const codePoints = Array.from(content);
  if (maxChars === undefined || codePoints.length <= maxChars) return { kept: content, chars: codePoints.length, truncated: false };
  const head = codePoints.slice(0, Math.max(0, maxChars));
  const lastNewline = head.lastIndexOf('\n');
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  return { kept: kept.join(''), chars: kept.length, truncated: true };
}

function neutraliseMarkers(text: string): string {
  return text.replace(EXTERNAL_DATA_MARKER, EXTERNAL_DATA_MARKER_REPLACEMENT);
}

function sanitiseLabel(label: string): string {
  return label.replace(/\r\n|\r|\n/g, ' ').replace(/["<>]/g, '');
}

function wrapExternalData(key: string, label: string, body: string): string {
  return `<<<EXTERNAL_DATA section="${key}">>>\n--- ${label} ---\n${body}\n<<<END_EXTERNAL_DATA>>>`;
}

/**
 * Compose the system and user messages. Throws `ComposeDataBlockKeyError`,
 * `PromptVariableUnresolvedError` (every missing path), `PromptTemplateSyntaxError` and `PromptCompositionEmptyError` — never a partial prompt.
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
    const key = String(block.key);
    if (!COMPOSE_DATA_BLOCK_KEY_PATTERN.test(key)) throw new ComposeDataBlockKeyError(key);
    if (!nonEmpty(block.content)) continue;
    if (input.dropEmptyBlocks === true && BLANK_CONTENT.test(block.content)) continue;
    const fitted = fitToBudget(block.content, block.maxChars);
    const body = neutraliseMarkers(fitted.kept) + (fitted.truncated ? EXTERNAL_DATA_TRUNCATION_MARKER : '');
    wrapped.push(wrapExternalData(key, sanitiseLabel(String(block.label)), body));
    blocks.push({ key, chars: fitted.chars, truncated: fitted.truncated });
  }

  return { system, user: wrapped.join(MESSAGE_LAYER_JOIN), selected: composed.selected, excluded: composed.excluded, blocks };
}
