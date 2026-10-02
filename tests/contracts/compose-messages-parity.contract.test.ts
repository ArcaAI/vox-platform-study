/**
 * `composeMessages` / `buildPromptScope` cross-language parity (TypeScript half).
 *
 * `@arcaai/workflow-contract` composes the messages for the gateway lanes; the harness's
 * `compose_messages.py` / `build_prompt_scope` compose them for the durable lane. Both read THIS
 * fixture — the Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_compose_messages_parity.py` — so
 * the FINAL system and user messages are byte-identical across the two runtimes, not merely the
 * template grammar. The suite also asserts the fixture is NOT VACUOUS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Imported from SOURCE by path: the repo root has no `@arcaai/workflow-contract` dependency.
const CONTRACT_SRC = path.resolve(__dirname, '../../packages/workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { PLATFORM_RULES_VERSION, buildPromptScope, composeMessages, outputLanguageStep, platformRules } = contract;

interface ComposeCase {
  name: string;
  input: {
    platformRules?: string;
    usePlatformRules?: boolean;
    resolvedPrompt: unknown;
    scopeParts: Record<string, unknown>;
    outputLanguage?: { name: string } | null;
    outputContract?: string | null;
    dataBlocks?: unknown[];
    templateRef?: string;
  };
  expected?: { system: string; user: string; selected: string[]; excluded: Array<{ key: string; reason: string }>; blocks: unknown[] };
  error?: { name: string; paths?: string[]; key?: string };
}

interface ScopeCase {
  name: string;
  parts: Record<string, unknown>;
  expected?: Record<string, unknown>;
  error?: { name: string; paths: string[] };
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'compose-messages.fixture.json'), 'utf-8')) as {
  platformRules: { version: string; text: string };
  outputLanguageStep: { name: string; text: string };
  scopeCases: ScopeCase[];
  cases: ComposeCase[];
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('compose-messages fixture — not vacuous', () => {
  it('carries at least 12 compose cases covering every rule, plus scope cases', () => {
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(12);
    const sources = new Set(fixture.cases.map((entry) => (entry.input.resolvedPrompt as { source?: string } | null)?.source ?? null));
    for (const source of ['template', 'inline', 'composite', null]) expect(sources).toContain(source);
    expect(fixture.cases.some((entry) => entry.input.outputLanguage?.name)).toBe(true);
    expect(fixture.cases.some((entry) => entry.expected?.blocks.some((block: any) => block.truncated))).toBe(true);
    expect(fixture.cases.some((entry) => entry.error?.name === 'PromptVariableUnresolved' && (entry.error.paths?.length ?? 0) > 1)).toBe(true);
    expect(names).toEqual(
      expect.arrayContaining(['data-block-injected-markers-neutralised', 'data-block-invalid-key-raises', 'data-block-label-sanitised']),
    );
    expect(fixture.cases.some((entry) => entry.expected?.user.includes('[external-data marker removed]'))).toBe(true);
    expect(fixture.scopeCases.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['trigger-only-aliases-context', 'context-only-aliases-trigger', 'both-kept-as-given']),
    );
  });
});

describe('platform rules and the language step', () => {
  it('match the fixture', () => {
    expect(platformRules()).toBe(fixture.platformRules.text);
    expect(PLATFORM_RULES_VERSION).toBe(fixture.platformRules.version);
    expect(outputLanguageStep(fixture.outputLanguageStep.name)).toBe(fixture.outputLanguageStep.text);
  });
});

describe('buildPromptScope over the shared fixture', () => {
  it.each(fixture.scopeCases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    if (entry.expected) {
      expect(buildPromptScope(clone(entry.parts))).toEqual(entry.expected);
      return;
    }
    let caught: any;
    try {
      buildPromptScope(clone(entry.parts));
    } catch (error) {
      caught = error;
    }
    expect(caught?.name).toBe(entry.error?.name);
    expect([...(caught?.paths ?? [])]).toEqual(entry.error?.paths);
  });
});

describe('composeMessages over the shared fixture', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const input = clone(entry.input);
    const run = () =>
      composeMessages({
        platformRules: input.usePlatformRules ? platformRules() : (input.platformRules ?? ''),
        resolvedPrompt: input.resolvedPrompt,
        scope: buildPromptScope(input.scopeParts),
        outputLanguage: input.outputLanguage,
        outputContract: input.outputContract,
        dataBlocks: input.dataBlocks,
        templateRef: input.templateRef,
      });
    if (entry.expected) {
      const result = run();
      expect(result.system).toBe(entry.expected.system);
      expect(result.user).toBe(entry.expected.user);
      expect(result.selected).toEqual(entry.expected.selected);
      expect(result.excluded.map(({ key, reason }: { key: string; reason: string }) => ({ key, reason }))).toEqual(entry.expected.excluded);
      expect(result.blocks).toEqual(entry.expected.blocks);
      return;
    }
    let caught: any;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught?.name).toBe(entry.error?.name);
    if (entry.error?.paths) expect([...caught.paths]).toEqual(entry.error.paths);
    if (entry.error?.key !== undefined) expect(caught.key).toBe(entry.error.key);
  });
});
