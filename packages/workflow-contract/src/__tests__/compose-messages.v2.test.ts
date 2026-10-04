/**
 * TASK-1036 OD-10 — nullable variables and empty-block dropping, OPT-IN.
 *
 * Runs `tests/contracts/compose-messages.v2.fixture.json`. The v1 fixture
 * (`compose-messages.fixture.json`) is untouched and is re-run here with the v2 code, which is the
 * proof that the defaults keep today's bytes: the harness's Python mirror is updated in wave B,
 * and until then nothing it compares against may move.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeMessages, type ComposeDataBlock } from '../compose-messages';
import type { ComposableResolvedPrompt } from '../prompt-composition';
import { buildPromptScope, type PromptScopeParts } from '../prompt-scope';
import { platformRules } from '../platform-rules';

interface ComposeCase {
  name: string;
  input: {
    platformRules?: string;
    usePlatformRules?: boolean;
    resolvedPrompt: ComposableResolvedPrompt;
    scopeParts: PromptScopeParts;
    outputLanguage?: { name: string } | null;
    outputContract?: string | null;
    dataBlocks?: ComposeDataBlock[];
    templateRef?: string;
    dropEmptyBlocks?: boolean;
  };
  expected?: unknown;
  error?: { name: string; paths?: string[]; key?: string };
}

interface ScopeCase {
  name: string;
  parts: PromptScopeParts;
  expected?: Record<string, unknown>;
  error?: { name: string; paths: string[] };
}

const CONTRACTS = path.resolve(__dirname, '../../../../tests/contracts');
const load = <T>(file: string): T => JSON.parse(readFileSync(path.join(CONTRACTS, file), 'utf-8')) as T;
const v2 = load<{ scopeCases: ScopeCase[]; cases: ComposeCase[] }>('compose-messages.v2.fixture.json');
const v1 = load<{ scopeCases: ScopeCase[]; cases: ComposeCase[] }>('compose-messages.fixture.json');

function run(entry: ComposeCase): unknown {
  const scope = buildPromptScope(entry.input.scopeParts);
  return composeMessages({
    platformRules: entry.input.usePlatformRules ? platformRules() : (entry.input.platformRules ?? ''),
    resolvedPrompt: entry.input.resolvedPrompt,
    scope,
    outputLanguage: entry.input.outputLanguage ?? null,
    outputContract: entry.input.outputContract ?? null,
    dataBlocks: entry.input.dataBlocks ?? [],
    ...(entry.input.templateRef === undefined ? {} : { templateRef: entry.input.templateRef }),
    ...(entry.input.dropEmptyBlocks === undefined ? {} : { dropEmptyBlocks: entry.input.dropEmptyBlocks }),
  });
}

function expectCase(entry: ComposeCase): void {
  if (entry.error) {
    let thrown: unknown;
    try {
      run(entry);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${entry.name} should throw`).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe(entry.error.name);
    if (entry.error.paths) expect((thrown as { paths: string[] }).paths).toEqual(entry.error.paths);
    if (entry.error.key) expect((thrown as { key: string }).key).toBe(entry.error.key);
    return;
  }
  const result = run(entry) as { excluded: Array<{ key: string; reason: string }> };
  // `detail` is the evaluator's own message and is not pinned across languages (v1 parity rule).
  expect({ ...result, excluded: result.excluded.map(({ key, reason }) => ({ key, reason })) }).toEqual(entry.expected);
}

function expectScopeCase(entry: ScopeCase): void {
  if (entry.error) {
    let thrown: unknown;
    try {
      buildPromptScope(entry.parts);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe(entry.error.name);
    expect((thrown as { paths: string[] }).paths).toEqual(entry.error.paths);
    return;
  }
  expect(buildPromptScope(entry.parts)).toEqual(entry.expected);
}

describe('compose-messages v2 fixture (OD-10, opt-in)', () => {
  it('is not vacuous', () => {
    expect(v2.cases.length).toBeGreaterThanOrEqual(8);
    expect(v2.scopeCases.length).toBeGreaterThanOrEqual(6);
    const names = [...v2.cases, ...v2.scopeCases].map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(v2.scopeCases.map((entry) => [entry.name, entry] as const))('scope: %s', (_name, entry) => expectScopeCase(entry));
  it.each(v2.cases.map((entry) => [entry.name, entry] as const))('compose: %s', (_name, entry) => expectCase(entry));
});

describe('compose-messages v1 fixture — byte-identical under the v2 code (defaults)', () => {
  it.each(v1.scopeCases.map((entry) => [entry.name, entry] as const))('scope: %s', (_name, entry) => expectScopeCase(entry));
  it.each(v1.cases.map((entry) => [entry.name, entry] as const))('compose: %s', (_name, entry) => expectCase(entry));
});
