/**
 * TASK-865 — deprecation markers are PRESENT, and each names its removal release.
 *
 * The program's deprecation policy (TASK-859 §6) is a marker in code plus a row
 * in `docs/operations/deprecation-register.md`; a future CI check fails on a
 * marker without a row. This suite pins the code half: every item in the ticket's
 * §3.2 deprecation set carries `@deprecated TASK-865 — removed in R<n>` (or its
 * package-level equivalent), so the register cannot claim a marker that does not
 * exist. Source-scan on purpose: the markers are documentation, and documentation
 * is text.
 *
 * Located by ascending from `process.cwd()` to the workspace marker, because
 * this suite runs under two roots (`packages/agentic-sdk-v2` and the repo root).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error(`could not locate the repo root above ${process.cwd()}`);
    dir = parent;
  }
}

const ROOT = findRepoRoot();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const MARKER = /@deprecated TASK-865 — removed in R\d/;

/** The four client-AI packages: `package.json#deprecated` + a README banner + a marked hook. */
const CLIENT_AI_PACKAGES = [
  { dir: 'packages/vad', hook: 'src/hooks/useVAD.ts', fn: 'useVAD' },
  { dir: 'packages/noise-filter', hook: 'src/hooks/useNoiseFilter.ts', fn: 'useNoiseFilter' },
  { dir: 'packages/stt', hook: 'src/hooks/useSTT.ts', fn: 'useSTT' },
  { dir: 'packages/med-ner', hook: 'src/hooks/useMedNER.ts', fn: 'useMedNER' },
] as const;

describe('client-AI packages are marked deprecated (TASK-865 §3.2)', () => {
  it.each(CLIENT_AI_PACKAGES)('$dir — package.json#deprecated names TASK-865 and the removal release', ({ dir }) => {
    const pkg = JSON.parse(read(`${dir}/package.json`)) as { deprecated?: string };
    expect(pkg.deprecated).toMatch(/TASK-865/);
    expect(pkg.deprecated).toMatch(/removed in R\d/);
  });

  it.each(CLIENT_AI_PACKAGES)('$dir — README opens with a deprecation banner', ({ dir }) => {
    const readme = read(`${dir}/README.md`);
    const banner = readme.split('\n').slice(0, 6).join('\n');
    expect(banner).toMatch(/DEPRECATED/);
    expect(banner).toMatch(/TASK-865/);
  });

  it.each(CLIENT_AI_PACKAGES)('$dir — the $fn hook carries the marker', ({ dir, hook, fn }) => {
    const source = read(`${dir}/${hook}`);
    const declaration = source.indexOf(`export function ${fn}(`);
    expect(declaration).toBeGreaterThan(0);
    // The marker must sit in the JSDoc immediately above the declaration.
    expect(source.slice(Math.max(0, declaration - 1200), declaration)).toMatch(MARKER);
  });
});

/** `@arcaai/vox` symbols in the deprecation set, with the identifier the marker must precede. */
const VOX_MARKED = [
  { file: 'src/hooks/useLocalVoiceEmbedding.ts', before: 'export function useLocalVoiceEmbedding(' },
  { file: 'src/hooks/usePipelines.ts', before: 'export function usePipelines(' },
  { file: 'src/hooks/usePipelines.ts', before: 'export const SELECTED_PIPELINE_SETTING' },
  { file: 'src/hooks/useArcaPipelines.ts', before: 'export function useArcaPipelines(' },
  { file: 'src/hooks/useSttProviderToggle.ts', before: 'export function useSttProviderToggle(' },
  // Anchored on the AudioStartOptions member (audio.ts has an earlier, unrelated `pipelineId?` on TranscriptionResult).
  { file: 'src/types/audio.ts', before: '  pipelineId?: string;\n  /**\n   * Slug of the published ASR Agent' },
  { file: 'src/types/config.ts', before: 'export const DEFAULT_LOCAL_CONFIG' },
  { file: 'src/types/config.ts', before: '  clientInference?: ClientInferenceConfig;' },
  { file: 'src/core/constants.ts', before: 'export const LOCAL_TRANSCRIPTION_ENABLED' },
  { file: 'src/core/constants.ts', before: 'export const PIPELINE_ENDPOINTS' },
  { file: 'src/core/TranscriptionPipeline.ts', before: 'export class TranscriptionPipeline' },
  { file: 'src/compat/types.ts', before: '  sttPipelineId?: string;' },
  // The three raw hooks are re-exported through their GATED wrappers (TASK-977 D-6),
  // so the marker is anchored on that export and on each wrapper's own declaration.
  { file: 'src/plugins.ts', before: "export { useVAD, useSTT, useNoiseFilter } from './hooks/useGatedClientStages';" },
  { file: 'src/hooks/useGatedClientStages.ts', before: 'export function useVAD(' },
  { file: 'src/hooks/useGatedClientStages.ts', before: 'export function useNoiseFilter(' },
  { file: 'src/hooks/useGatedClientStages.ts', before: 'export function useSTT(' },
  { file: 'src/plugins-med-ner.ts', before: "export { useMedNER } from '@arcaai/med-ner';" },
] as const;

describe('@arcaai/vox deprecation set carries the marker (TASK-865 §3.2)', () => {
  it.each(VOX_MARKED)('$file — marker precedes `$before`', ({ file, before }) => {
    const source = read(`packages/agentic-sdk-v2/${file}`);
    const at = source.indexOf(before);
    expect(at, `${before} not found in ${file}`).toBeGreaterThan(0);
    expect(source.slice(Math.max(0, at - 1500), at)).toMatch(MARKER);
  });

  it('useLocalVoiceEmbedding warns on the console (once) — the marker alone is invisible at runtime', () => {
    const source = read('packages/agentic-sdk-v2/src/hooks/useLocalVoiceEmbedding.ts');
    expect(source).toMatch(/console\.warn\([\s\S]*?deprecated/i);
    expect(source).toMatch(/once/i);
  });

  it('every TASK-865 marker in the SDK names its removal release', () => {
    const files = [...new Set(VOX_MARKED.map((entry) => `packages/agentic-sdk-v2/${entry.file}`)), ...CLIENT_AI_PACKAGES.map((p) => `${p.dir}/${p.hook}`)];
    for (const file of files) {
      for (const line of read(file).split('\n')) {
        if (line.includes('@deprecated TASK-865')) {
          expect(line, `${file}: ${line.trim()}`).toMatch(/removed in R\d/);
        }
      }
    }
  });
});

describe('the admin console cannot import a client-AI package (ESLint, TASK-865)', () => {
  const preset = read('packages/config-eslint/flat/next.js');

  it.each(['@arcaai/vad', '@arcaai/noise-filter', '@arcaai/med-ner', '@arcaai/vox/plugins/med-ner', '@arcaai/stt'])('bans %s via no-restricted-imports', (name) => {
    expect(preset).toContain(`name: '${name}'`);
    expect(preset).toMatch(/TASK-865/);
  });

  it('keeps the capture-only helpers of @arcaai/stt reachable (they run no model)', () => {
    // `createAudioCapture` / `float32ToInt16` are PCM plumbing the live-transcription
    // playground uses; only the inference surface of the package is banned.
    expect(preset).toMatch(/allowImportNames:\s*\[[^\]]*'createAudioCapture'/);
  });
});
