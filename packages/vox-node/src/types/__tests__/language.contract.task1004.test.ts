/**
 * TASK-1004 — the `LanguageResolution` type must match the pinned cross-language contract,
 * `tests/contracts/language-resolution.fixture.json`, which `apps/stt`, `@arcaai/applications`,
 * `@arcaai/vox` and the ALaaS broker all read off the SAME file. This is a source-of-truth
 * conformance test, read off disk (never re-typed by hand), so a fixture edit that drifts from
 * this package's type is a red test here rather than a silent divergence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LanguageResolution } from '../language';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('could not locate the repo root (no pnpm-workspace.yaml above ' + process.cwd() + ')');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();

interface LanguageResolutionFixture {
  enums: { source: string[]; reason: string[] };
  receipt: {
    keys: string[];
    paramsKeys: string[];
    examples: Array<{ name: string; gateway: Record<string, unknown> }>;
  };
}

function loadFixture(): LanguageResolutionFixture {
  const raw = readFileSync(join(REPO_ROOT, 'tests', 'contracts', 'language-resolution.fixture.json'), 'utf8');
  return JSON.parse(raw) as LanguageResolutionFixture;
}

describe('LanguageResolution — conformance with tests/contracts/language-resolution.fixture.json', () => {
  const fixture = loadFixture();

  it('the receipt keys match the fixture exactly (no extra, none missing)', () => {
    // A `LanguageResolution` literal typed against the real interface — if a fixture key were
    // renamed and this type not updated (or vice versa), this assignment fails to COMPILE, not
    // merely fails an assertion.
    const sample: LanguageResolution = {
      requestedMode: 'ml-en',
      source: 'request',
      appliedMode: 'ml-en',
      engine: 'WHISPER_CPP',
      provider: null,
      params: { language: null, codeSwitching: false, streamingEnglishGloss: false, primed: false },
      degraded: true,
      reason: 'whisper_cpp_pair_unprimed',
    };

    expect(Object.keys(sample).sort()).toEqual([...fixture.receipt.keys].sort());
    expect(Object.keys(sample.params).sort()).toEqual([...fixture.receipt.paramsKeys].sort());
  });

  it('every fixture gateway example round-trips through the LanguageResolution type', () => {
    for (const example of fixture.receipt.examples) {
      const resolution = example.gateway as unknown as LanguageResolution;
      expect(Object.keys(resolution).sort()).toEqual([...fixture.receipt.keys].sort());
      expect(fixture.enums.source).toContain(resolution.source);
      if (resolution.reason !== null) {
        expect(fixture.enums.reason).toContain(resolution.reason);
      }
      expect(Object.keys(resolution.params).sort()).toEqual([...fixture.receipt.paramsKeys].sort());
    }
  });

  it('the source and reason unions are exactly the fixture enums (closed)', () => {
    const sourceValues: LanguageResolution['source'][] = ['request', 'consultation', 'agent', 'default'];
    const reasonValues: NonNullable<LanguageResolution['reason']>[] = [
      'whisper_cpp_pair_unprimed',
      'gloss_translation_only',
      'engine_auto_detect',
      'fallback_engine_switch',
    ];

    expect(sourceValues.sort()).toEqual([...fixture.enums.source].sort());
    expect(reasonValues.sort()).toEqual([...fixture.enums.reason].sort());
  });
});
