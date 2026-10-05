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
