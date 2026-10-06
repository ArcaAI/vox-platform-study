/**
 * TASK-1047 — reading what `PromptAssemblyService` handed the ONE composer.
 *
 * Since FC-1 the composer (`composeMessages`) renders every placeholder as a pointer and its value
 * as a data block; WHERE a value may appear in the system message is therefore the composer's
 * contract, and these suites pin this service's half of it at the composer's INPUT: which block a
 * placeholder points at (`blockAliases`), what the scope binds, and that the rest of the system side
 * (platform rules + contract parts) carries no runtime value.
 *
 * A suite using this module must spy the composer through:
 *
 * ```ts
 * vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
 *   return { ...actual, composeMessages: vi.fn(actual.composeMessages) };
 * });
 * ```
 */
import { expect, vi } from 'vitest';
import { composeMessages, type ComposeMessagesInput } from '@arcaai/workflow-contract';

/** The input of the most recent composer call. */
export function lastComposeInput(): ComposeMessagesInput {
  const calls = vi.mocked(composeMessages).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0];
}

/** The placeholder path → block name map the composer was given. */
export function lastBlockAliases(): Readonly<Record<string, string>> {
  return lastComposeInput().blockAliases ?? {};
}

/** Every part of the system message besides the governed instruction: the rules and the contract. */
export function lastSystemSide(): string {
  const input = lastComposeInput();
  return [input.platformRules, input.outputContract ?? '', ...(input.outputContractParts ?? []).map((part) => part.text)].join('\n');
}

/** The `context` view of the scope the composer rendered against. */
export function lastScopeContext(): Record<string, unknown> {
  return ((lastComposeInput().scope as { context?: Record<string, unknown> }).context ?? {}) as Record<string, unknown>;
}

const EXTERNAL_DATA_BLOCK = /<<<EXTERNAL_DATA section="([a-z0-9_]+)">>>\n--- [^\n]* ---\n([\s\S]*?)\n<<<END_EXTERNAL_DATA>>>/g;

/** The data blocks of a composed user message, by key (first occurrence wins). */
export function dataBlocksOf(user: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of user.matchAll(EXTERNAL_DATA_BLOCK)) if (!blocks.has(match[1]!)) blocks.set(match[1]!, match[2]!);
  return blocks;
}

/**
 * The system message with every FC-1 pointer replaced by the value of the block it names — the
 * prompt as the model READS it. For suites about how a value RESOLVES (department names, language
 * maps, defaults), not about where it travels; where it travels is asserted on the raw system.
 */
export function resolvePointers(system: string, user: string): string {
  const blocks = dataBlocksOf(user);
  return system.replace(/\[see the ([a-z0-9_]+) data section below\]/g, (pointer, key: string) => blocks.get(key) ?? pointer);
}

/**
 * A `PromptAssemblyService` whose `assemble` reports `systemPrompt` with its pointers resolved
 * (see {@link resolvePointers}) and the raw system as `governedSystemPrompt`.
 */
export function resolvingPointers<T extends { assemble(params: never): Promise<{ systemPrompt: string; userPrompt: string }> }>(
  service: T,
): T & { assemble(params: Parameters<T['assemble']>[0]): Promise<Awaited<ReturnType<T['assemble']>> & { governedSystemPrompt: string }> } {
  const assemble = service.assemble.bind(service) as (params: unknown) => Promise<{ systemPrompt: string; userPrompt: string }>;
  return Object.assign(Object.create(service) as T, {
    assemble: async (params: unknown) => {
      const result = await assemble(params);
      return { ...result, systemPrompt: resolvePointers(result.systemPrompt, result.userPrompt), governedSystemPrompt: result.systemPrompt };
    },
  }) as never;
}
