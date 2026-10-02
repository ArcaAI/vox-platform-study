/**
 * What `composeMessages` makes of a live turn, for tests that pin the bytes sent to TEXT.
 *
 * SYSTEM = platform rules → the agent's instruction → the turn's instructions (stable lead-in,
 * directive, operating frame, turn contract) → the corrective (repair only).
 * USER   = the turn's data, each block `<<<EXTERNAL_DATA section="<key>">>>\n--- <label> ---\n…`.
 */
import { composeMessages, platformRules, type ComposeDataBlock } from '@arcaai/workflow-contract';

/** The user message a set of live turn blocks composes into. */
export function liveUserOf(parts: { readonly blocks: readonly ComposeDataBlock[] }): string {
  return composeMessages({ platformRules: '', resolvedPrompt: null, scope: {}, dataBlocks: parts.blocks }).user;
}

/** The shape `buildLivePromptParts` returns. */
export interface LiveParts {
  readonly instructions: string;
  readonly blocks: readonly ComposeDataBlock[];
}

/** The system message up to and including the agent's instruction and the separator after it. */
export function agentSystemHead(instruction: string): string {
  return `${platformRules()}\n\n${instruction}\n\n`;
}

/** The first `agentSystemHead(instruction).length` characters of a sent system message. */
export function headOf(system: unknown, instruction: string): string {
  return String(system).slice(0, agentSystemHead(instruction).length);
}

/** The system message up to and including the turn's stable lead-in. */
export function liveSystemHead(instruction: string, stablePrefix: string): string {
  return `${agentSystemHead(instruction)}${stablePrefix}`;
}

/** One delimited data block as it appears in the user message. */
export function dataBlock(key: string, label: string, content: string): string {
  return `<<<EXTERNAL_DATA section="${key}">>>\n--- ${label} ---\n${content}\n<<<END_EXTERNAL_DATA>>>`;
}
