/**
 * What `composeMessages` makes of an agent instruction and its input, for tests that pin the
 * exact bytes sent: the platform rules lead the SYSTEM message, and the caller's text is the one
 * delimited data block of the USER message.
 */
import { platformRules } from '@arcaai/workflow-contract';

/** The system message for a rendered instruction. */
export function withPlatformRules(instruction: string): string {
  return `${platformRules()}\n\n${instruction}`;
}

/** The user message for an invocation's `input.text`. */
export function asInputBlock(text: string): string {
  return `<<<EXTERNAL_DATA section="input">>>\n--- Input ---\n${text}\n<<<END_EXTERNAL_DATA>>>`;
}

export { dataBlocksOf, resolvePointers } from '../../consultation/prompt/__tests__/compose-spy';

/**
 * TASK-1047 FC-1 — the SYSTEM message as the model reads it: every pointer replaced by the value of
 * the data block it names. For assertions about how a value RESOLVES; where it travels (a pointer
 * in system, the value in a block) is asserted on the raw body.
 */
export function readByModel(body: { system_prompt?: unknown; prompt?: unknown }): string {
  return resolvePointersOf(String(body.system_prompt ?? ''), String(body.prompt ?? ''));
}

import { resolvePointers as resolvePointersOf } from '../../consultation/prompt/__tests__/compose-spy';
