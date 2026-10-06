/**
 * TASK-1047 FC-1/FC-2 — the static PIECES of an instruction, as the system message will carry them.
 *
 * A governed piece is screened and registered by `sha256(utf8(text))`. For the call-time check to
 * find it, the text registered here must be byte-identical to the piece the composer emits — which,
 * after FC-1, is the instruction with every placeholder rendered as a fixed pointer to its data
 * block. So a piece never contains a runtime value, and screening it at authoring time covers it
 * for every consultation.
 */
import { createHash } from 'node:crypto';
import type { GovernedPieceInput, GovernedPromptSourceKind } from './IGovernedPromptRegistry';

/** FC-2 — `digest(text) = sha256(utf8(text))`, lower-case hex. */
export function pieceDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** FC-1 — the block name a placeholder path points at: lower-cased, every non `[a-z0-9]` run → `_`. */
export function pointerBlockName(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * One placeholder, mirroring `@arcaai/workflow-contract`'s `template.ts` grammar:
 * `"{{" WS? path ( WS? "|" WS? "default" WS? "(" WS? string WS? ")" )? WS? "}}"`.
 * Sticky, so it only matches AT the scan position.
 */
const PLACEHOLDER =
  /\{\{[ \t]*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:[ \t]*\|[ \t]*default[ \t]*\([ \t]*"(?:[^"\\]|\\[\s\S])*"[ \t]*\))?[ \t]*\}\}/y;

/**
 * FC-1 pointer mode: every placeholder → `[see the <block> data section below]`; `{{{{` → `{{`; a
 * malformed `{{` stays literal (the contract's scanner records a problem and resumes the same way —
 * publish refuses such a template with `PROMPT_TEMPLATE_SYNTAX` regardless).
 *
 * TODO(TASK-1047 FC-1): replace with the contract's pointer render option once Lane L1 lands it in
 * `@arcaai/workflow-contract` (the orchestrator swaps this at merge). The block naming here is FC-1's
 * derived rule plus the caller's `aliases`; a composer that names a block differently produces a
 * different digest, which falls back to full screening — never to a skip.
 */
export function renderPointerMode(content: string, aliases: Readonly<Record<string, string>> = {}): string {
  let out = '';
  let index = 0;
  while (index < content.length) {
    if (content.startsWith('{{{{', index)) {
      out += '{{';
      index += 4;
      continue;
    }
    if (content.startsWith('{{', index)) {
      PLACEHOLDER.lastIndex = index;
      const match = PLACEHOLDER.exec(content);
      if (match) {
        const path = match[1] as string;
        out += `[see the ${aliases[path] ?? pointerBlockName(path)} data section below]`;
        index = PLACEHOLDER.lastIndex;
        continue;
      }
      out += '{{';
      index += 2;
      continue;
    }
    out += content[index];
    index += 1;
  }
  return out;
}

export interface PieceSource {
  readonly sourceType: GovernedPromptSourceKind;
  readonly sourceId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The instruction pieces of a frozen `compiledConfig.resolvedPrompt` (FC-2): a template or inline
 * body is ONE `TEMPLATE_BODY` piece keyed `body`; a composite is one `FRAGMENT` piece per fragment,
 * keyed by the fragment key (every fragment, selected at run time or not). An empty body is no piece.
 */
export function piecesFromResolvedPrompt(
  resolvedPrompt: unknown,
  source: PieceSource,
  aliases?: Readonly<Record<string, string>>,
): GovernedPieceInput[] {
  const prompt = asRecord(resolvedPrompt);
  if (!prompt) return [];
  if (prompt.source === 'composite') {
    const fragments = Array.isArray(prompt.fragments) ? prompt.fragments : [];
    return fragments.flatMap((raw) => {
      const fragment = asRecord(raw);
      if (!fragment || typeof fragment.key !== 'string' || typeof fragment.content !== 'string' || fragment.content.length === 0) return [];
      return [{ kind: 'FRAGMENT' as const, ...source, sourceKey: fragment.key, text: renderPointerMode(fragment.content, aliases) }];
    });
  }
  if ((prompt.source === 'template' || prompt.source === 'inline') && typeof prompt.content === 'string' && prompt.content.length > 0) {
    return [{ kind: 'TEMPLATE_BODY', ...source, sourceKey: 'body', text: renderPointerMode(prompt.content, aliases) }];
  }
  return [];
}

/**
 * A prompt template's body at APPROVE time. `sourceId` is the PromptTemplate id: the approved
 * PromptVersion is minted inside the approval transaction, after the screen must already have
 * refused, so a PROMPT_VERSION row names the template lineage it was approved under.
 */
export function templateBodyPiece(content: string, promptTemplateId: string): GovernedPieceInput {
  return { kind: 'TEMPLATE_BODY', sourceType: 'PROMPT_VERSION', sourceId: promptTemplateId, sourceKey: 'body', text: renderPointerMode(content) };
}
