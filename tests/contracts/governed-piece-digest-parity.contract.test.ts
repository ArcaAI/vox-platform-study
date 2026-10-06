/**
 * TASK-1047 FC-2/FC-3 — an AUTHORING-time piece digest (what the registry screens and records at
 * approve / publish) equals the CALL-time piece digest `composeMessages` emits for the same
 * instruction, for every seeded prompt. If these ever diverge, governed calls silently fall back to
 * full screening (safe, but the efficiency of TASK-1047 is lost) — this test makes divergence loud.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Imported from SOURCE by path: the repo root has no `@arcaai/workflow-contract` dependency.
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ path.resolve(__dirname, '../../packages/workflow-contract/src/index.ts'));
const { collectPlaceholders, composeMessages, platformRules, templateSyntaxProblems } = contract;
const pieces: any = await import(
  /* @vite-ignore */ path.resolve(__dirname, '../../packages/applications/src/services/governed-prompt/governed-pieces.ts')
);

const SEED_DIR = path.resolve(__dirname, '../../packages/database/src/prisma/db_main/seed');
const SEED_MODULES = [
  '07-prompt-template.ts',
  '07a-agent-golden-library.ts',
  '07b-arcaai-clinical-content.ts',
  '07b-arcaai-clinical-content-v2.ts',
  '07b-arcaai-clinical-content-v3.ts',
  '07b-arcaai-clinical-templates.ts',
  '07c-live-agent-defaults.ts',
  '07d-dept-free-pre-summary-default.ts',
  '07e-consultation-note-context-schema.ts',
  '07g-arcaai-two-schemas.ts',
  '08-dna-writing-style.ts',
  '25-agents.ts',
  '28-workflow-library.ts',
  '28-workflow-library.generated.ts',
  '29-arcaai-agents-and-workflows.ts',
  '29-arcaai-agents-and-workflows.generated.ts',
];

interface SeededPrompt {
  readonly where: string;
  readonly content: string;
}

function collectPromptStrings(value: unknown, where: string, out: SeededPrompt[], seen: Set<unknown>): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) out.push({ where, content: value });
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPromptStrings(item, `${where}[${index}]`, out, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) collectPromptStrings(child, `${where}.${key}`, out, seen);
}

/** A scope in which every placeholder path resolves to a unique sentinel (a path that is a prefix of another keeps the deeper one). */
function sentinelScope(paths: readonly string[]): { scope: Record<string, unknown>; sentinels: Map<string, string> } {
  const scope: Record<string, unknown> = {};
  const sentinels = new Map<string, string>();
  // Longest first, so a namespace is built before a shorter path would claim it as a leaf.
  for (const one of [...paths].sort((a, b) => b.split('.').length - a.split('.').length)) {
    const segments = one.split('.');
    let node: Record<string, unknown> = scope;
    let ok = true;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) node[segment] = {};
      else if (typeof next !== 'object' || next === null) {
        ok = false;
        break;
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (!ok || node[leaf] !== undefined) continue;
    const sentinel = `⟦RUNTIME-${sentinels.size}⟧`;
    node[leaf] = sentinel;
    sentinels.set(one, sentinel);
  }
  return { scope, sentinels };
}

const prompts: SeededPrompt[] = [];
for (const file of SEED_MODULES) {
  const loaded = await import(/* @vite-ignore */ path.join(SEED_DIR, file));
  const seen = new Set<unknown>();
  for (const [name, value] of Object.entries(loaded)) collectPromptStrings(value, `${file}:${name}`, prompts, seen);
}
const parseable = prompts.filter((prompt) => templateSyntaxProblems(prompt.content).length === 0);
const withPlaceholders = parseable.filter((prompt) => collectPlaceholders(prompt.content).length > 0);

describe('authoring-time piece digests equal call-time composer digests (TASK-1047 FC-2/FC-3)', () => {
  it('finds the seeded prompt corpus (not vacuous)', () => {
    expect(withPlaceholders.length).toBeGreaterThanOrEqual(10);
  });

  it.each(withPlaceholders.map((prompt) => [prompt.where, prompt] as const))('%s', (_where, prompt) => {
    const paths = collectPlaceholders(prompt.content).map((reference: { path: string }) => reference.path);
    const { scope } = sentinelScope(paths);
    const composed = composeMessages({
      platformRules: platformRules(),
      resolvedPrompt: { source: 'inline', content: prompt.content },
      scope,
    });
    const callTime = composed.governance.pieces.find((piece: { kind: string }) => piece.kind === 'TEMPLATE_BODY');
    const [authoring] = pieces.piecesFromResolvedPrompt({ source: 'inline', content: prompt.content }, { sourceType: 'AGENT', sourceId: 'a' });
    expect(authoring).toBeDefined();
    expect(callTime).toBeDefined();
    expect(pieces.pieceDigest(authoring.text)).toBe(callTime.digest);
  });
});
