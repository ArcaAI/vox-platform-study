/**
 * Orchestration: read the two artifacts → build the surface → render → write
 * (or, in `--check` mode, compare).
 *
 * ## Why `--check` re-generates instead of hashing
 *
 * The drift gate mirrors the repo's existing `generate-*-check` CI jobs
 * (`.gitlab/ci/validate.yml`): run the generator, diff the result against what
 * is committed, fail on any difference. That catches BOTH directions with one
 * mechanism — a hand-edit to a generated file, and a generated file that is
 * stale because a route or DTO changed under it. A stored hash would only
 * catch the first.
 *
 * ## Files this generator owns
 *
 * Everything in the output directory EXCEPT `admin-resource.ts` and
 * `__tests__/`, which are hand-authored (ticket §3.2: the base class is "the
 * part that carries judgment"). Generation therefore also DELETES generated
 * files that no longer correspond to an area — otherwise removing an admin
 * area would leave a module exporting a resource for a scope that no longer
 * exists, and the drift gate would not notice.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { emitSurface } from './emit';
import type { EmittedFile } from './emit';
import { buildAdminSurface } from './surface';
import type { OpenApiDocument, RouteManifest } from './types';

/** Hand-authored files in the output directory that generation must never touch. */
export const HAND_AUTHORED = new Set(['admin-resource.ts']);

export interface GenerateOptions {
  /** Path to `apps/api/route-manifest.json`. */
  manifestPath: string;
  /** Path to `apps/api/openapi.json`. */
  openApiPath: string;
  /** Directory the modules are written to (`packages/vox-node/src/resources/admin`). */
  outDir: string;
  /** Compare instead of write. */
  check?: boolean;
}

export interface GenerateResult {
  files: EmittedFile[];
  areas: number;
  methods: number;
  schemas: number;
  /** `--check` only: relative paths that differ from (or are missing on) disk. */
  drifted: string[];
  /** `--check` only: generated-looking files on disk that generation would delete. */
  orphaned: string[];
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const manifest = JSON.parse(readFileSync(options.manifestPath, 'utf8')) as RouteManifest;
  const document = JSON.parse(readFileSync(options.openApiPath, 'utf8')) as OpenApiDocument;

  const surface = buildAdminSurface(manifest, document);
  const rendered = emitSurface(surface);

  // Prettier is applied so the emitted tree is CANONICAL: a diff in the drift
  // gate is then always a semantic change, never a line-wrapping difference
  // between whoever last touched the template. It is deterministic for a
  // pinned prettier version, which is what the lockfile guarantees.
  const prettierConfig = (await resolveConfig(join(options.outDir, 'index.ts'))) ?? {};
  const files: EmittedFile[] = [];
  for (const file of rendered) {
    files.push({
      relativePath: file.relativePath,
      contents: await format(file.contents, { ...prettierConfig, parser: 'typescript' }),
    });
  }

  const expected = new Set(files.map((file) => file.relativePath));
  const onDisk = listGeneratedFiles(options.outDir);
  const orphaned = onDisk.filter((name) => !expected.has(name)).sort();

  const result: GenerateResult = {
    files,
    areas: surface.areas.length,
    methods: surface.areas.reduce((sum, area) => sum + area.methods.length, 0),
    schemas: surface.schemas.length,
    drifted: [],
    orphaned,
  };

  if (options.check) {
    for (const file of files) {
      const path = join(options.outDir, file.relativePath);
      let actual: string | undefined;
      try {
        actual = readFileSync(path, 'utf8');
      } catch {
        actual = undefined;
      }
      if (actual !== file.contents) result.drifted.push(file.relativePath);
    }
    return result;
  }

  mkdirSync(options.outDir, { recursive: true });
  for (const name of orphaned) rmSync(join(options.outDir, name));
  for (const file of files) writeFileSync(join(options.outDir, file.relativePath), file.contents, 'utf8');
  return result;
}

/** Top-level `.ts` files in the output directory that are NOT hand-authored. */
function listGeneratedFiles(outDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.filter((name) => !HAND_AUTHORED.has(name)).sort();
}
