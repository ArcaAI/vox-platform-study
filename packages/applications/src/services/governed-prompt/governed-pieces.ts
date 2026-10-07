/**
 * TASK-1047 FC-1/FC-2 — the static PIECES of an instruction, as the system message will carry them.
 *
 * A governed piece is screened and registered by `sha256(utf8(text))`. For the call-time check to
 * find it, the text registered here must be byte-identical to the piece the composer emits — which,
 * after FC-1, is the instruction with every placeholder rendered as a fixed pointer to its data
 * block. So a piece never contains a runtime value, and screening it at authoring time covers it
 * for every consultation.
 */
import { placeholderBlockName, renderTemplatePointers, sha256Hex, templateReferences } from '@arcaai/workflow-contract';
import { PROMPT_ASSEMBLY_BLOCK_ALIASES } from '../consultation/prompt/prompt-assembly-blocks';
import type { GovernedPieceInput, GovernedPromptSourceKind } from './IGovernedPromptRegistry';

/** FC-2 — `digest(text) = sha256(utf8(text))`, lower-case hex — the contract's own implementation. */
export function pieceDigest(text: string): string {
  return sha256Hex(text);
}

/** FC-1 — the block name a placeholder path points at (the contract's derived rule). */
export function pointerBlockName(path: string): string {
  return placeholderBlockName(path);
}

/**
 * A stand-in scope in which every referenced path resolves: pointer text never depends on a value,
 * so authoring time (which has no scope) renders exactly what the composer renders at call time.
 * Longest paths first, so a namespace is built before a shorter path could claim it as a leaf.
 */
function standInScope(content: string): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const paths = templateReferences(content).map((reference) => reference.path);
  for (const one of [...paths].sort((a, b) => b.split('.').length - a.split('.').length)) {
    const segments = one.split('.');
    let node: Record<string, unknown> = scope;
    let blocked = false;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) node[segment] = {};
      else if (typeof next !== 'object' || next === null) {
        blocked = true;
        break;
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (!blocked && node[leaf] === undefined) node[leaf] = '';
  }
  return scope;
}

/**
 * FC-1 pointer mode, rendered by the contract (`renderTemplatePointers`) — byte-identical to the
 * pieces `composeMessages` emits, held by `tests/contracts/governed-piece-digest-parity.contract.test.ts`.
 * A template with syntax problems cannot render; its raw text is screened instead (publish refuses it
 * with `PROMPT_TEMPLATE_SYNTAX` regardless, so it never becomes a governed piece in use).
 */
export function renderPointerMode(content: string, aliases: Readonly<Record<string, string>> = {}): string {
  try {
    return renderTemplatePointers(content, standInScope(content), { blockAliases: aliases }).text;
  } catch {
    // swallow-ok: a syntactically broken template is refused at publish; screening its raw text is the safe fallback
    return content;
  }
}

/**
 * Every pointer rendering of `content` a composer can emit: the contract's derived block names, and
 * the prompt-assembly path's aliased names (`PROMPT_ASSEMBLY_BLOCK_ALIASES`) when they differ. Each
 * variant is screened and registered, so a governed call matches whichever path composed it.
 */
export function pointerVariants(content: string, aliases?: Readonly<Record<string, string>>): string[] {
  const base = renderPointerMode(content, aliases);
  const assembly = renderPointerMode(content, { ...PROMPT_ASSEMBLY_BLOCK_ALIASES, ...(aliases ?? {}) });
  return assembly === base ? [base] : [base, assembly];
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
      const key: string = fragment.key;
      return pointerVariants(fragment.content, aliases).map((text) => ({ kind: 'FRAGMENT' as const, ...source, sourceKey: key, text }));
    });
  }
  if ((prompt.source === 'template' || prompt.source === 'inline') && typeof prompt.content === 'string' && prompt.content.length > 0) {
    return pointerVariants(prompt.content, aliases).map((text) => ({ kind: 'TEMPLATE_BODY' as const, ...source, sourceKey: 'body', text }));
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

/** Every pointer variant of a template body at APPROVE time (see `pointerVariants`). */
export function templateBodyPieces(content: string, promptTemplateId: string): GovernedPieceInput[] {
  return pointerVariants(content).map((text) => ({
    kind: 'TEMPLATE_BODY' as const,
    sourceType: 'PROMPT_VERSION' as const,
    sourceId: promptTemplateId,
    sourceKey: 'body',
    text,
  }));
}

/**
 * TASK-1049 F11 — a DNA_ANALYSIS template's body, in the same pointer mode as any approved template
 * body. The DNA job sends it as the SYSTEM prompt; screening it before use is what makes it authored
 * text rather than call-time instruction.
 */
export function dnaAnalysisTemplatePieces(content: string, promptTemplateId: string): GovernedPieceInput[] {
  return content.length === 0 ? [] : templateBodyPieces(content, promptTemplateId);
}

/** The minimal graph shape the authoring check reads (structurally `WorkflowGraph`). */
export interface AuthoredWorkflowGraph {
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly type: string; readonly config?: Record<string, unknown> | null }>;
}

/**
 * TASK-1049 F11 — the TENANT-AUTHORED text a workflow definition carries into a prompt: each
 * `core.agent` node's `overrides.promptVariables` values, and every `{ template }` binding anywhere in a
 * node's config. Both are authored once and rendered into every run, so they are screened at publish
 * like any instruction. `{ from }` / `{ firstOf }` read run data, `{ value }` literals are values, and a
 * `core.note` is never compiled — none of those is a prompt. `sourceKey` names the node and the path.
 * There is no governed-piece row type for a workflow definition, so these are VALIDATED
 * (`IGovernedPromptRegistry.validateAuthoredPieces`), never registered.
 */
export function workflowGraphPromptPieces(graph: AuthoredWorkflowGraph, workflowDefinitionId: string): GovernedPieceInput[] {
  const pieces: GovernedPieceInput[] = [];
  // `sourceType` is required by the piece type; there is no WORKFLOW_DEFINITION row type, and these pieces
  // are validated only, never registered, so the nearest kind (a node runs an agent) is used.
  const add = (sourceKey: string, text: string) => {
    if (text.trim().length > 0) pieces.push({ kind: 'FRAGMENT', sourceType: 'AGENT', sourceId: workflowDefinitionId, sourceKey, text });
  };
  for (const node of graph.nodes ?? []) {
    if (node.type === 'core.note' || !asRecord(node.config)) continue;
    const config = node.config as Record<string, unknown>;
    const variables = asRecord(asRecord(config.overrides)?.promptVariables);
    for (const [name, value] of Object.entries(variables ?? {})) if (typeof value === 'string') add(`${node.id}.promptVariables.${name}`, value);
    const walk = (value: unknown, path: string[]): void => {
      const record = asRecord(value);
      if (record) {
        const keys = Object.keys(record);
        if (keys.length === 1 && keys[0] === 'template' && typeof record.template === 'string') {
          add(`${node.id}.${[...path, 'template'].join('.')}`, record.template);
          return;
        }
        for (const [key, child] of Object.entries(record)) if (!(path.length === 0 && key === 'overrides')) walk(child, [...path, key]);
        return;
      }
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, [...path, String(index)]));
    };
    walk(config, []);
  }
  return pieces;
}
