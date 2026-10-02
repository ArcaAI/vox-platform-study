import type { ComposeDataBlock } from '@arcaai/workflow-contract';

/**
 * The caller's `input.text` as the ONE data block of an agent invocation (and of the draft bench,
 * which must send the same bytes). Empty text emits no block, so the user message is `''`.
 */
export function agentInputBlock(text: unknown): ComposeDataBlock {
  return { key: 'input', label: 'Input', content: typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text) };
}
