/** One-shot orchestration for the business-plane mode: fetch the published catalogue, generate, write. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkAgainstDisk, type CheckResult } from './check';
import { fetchPublishedCatalogue, type FetchPublishedCatalogueOptions } from './fetch-catalogue';
import { generateCatalogueTypes, type CatalogueSurface } from './generate-catalogue';

export interface RunCatalogueCodegenOptions extends FetchPublishedCatalogueOptions {
  /** DIRECTORY, not a file: this mode may emit one file per plane. */
  outDir: string;
  /** Injectable for deterministic tests. */
  generatedAt?: Date;
}

export interface WrittenCatalogueFile {
  surface: CatalogueSurface;
  path: string;
  count: number;
}

export interface RunCatalogueCodegenResult {
  files: WrittenCatalogueFile[];
}

/**
 * Fetch + generate + write, once.
 *
 * One file per REQUESTED plane, named after it — `agents.generated.ts`,
 * `workflows.generated.ts`. Not one combined file: the two planes are read with different
 * routes and change on different cadences, and a combined file makes every workflow edit dirty
 * the agents an unrelated team imports.
 */
export async function runCatalogueCodegenOnce(options: RunCatalogueCodegenOptions): Promise<RunCatalogueCodegenResult> {
  const catalogue = await fetchPublishedCatalogue(options);
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });

  const surfaces: CatalogueSurface[] = [];
  if (options.agents) surfaces.push('agents');
  if (options.workflows) surfaces.push('workflows');

  const files: WrittenCatalogueFile[] = [];
  for (const surface of surfaces) {
    const file = generateCatalogueTypes(catalogue, { surface, baseUrl: options.baseUrl, generatedAt: options.generatedAt });
    const path = join(outDir, `${surface}.generated.ts`);
    await writeFile(path, file.contents, 'utf8');
    files.push({ surface, path, count: file.count });
  }
  return { files };
}

export interface CheckedCatalogueFile extends WrittenCatalogueFile {
  check: CheckResult;
}

export interface CheckCatalogueCodegenResult {
  files: CheckedCatalogueFile[];
}

/** Fetch + generate in memory for every requested plane, then compare each against its file in `options.outDir`. Never writes. */
export async function checkCatalogueCodegenOnce(options: RunCatalogueCodegenOptions): Promise<CheckCatalogueCodegenResult> {
  const catalogue = await fetchPublishedCatalogue(options);
  const outDir = resolve(options.outDir);

  const surfaces: CatalogueSurface[] = [];
  if (options.agents) surfaces.push('agents');
  if (options.workflows) surfaces.push('workflows');

  const files: CheckedCatalogueFile[] = [];
  for (const surface of surfaces) {
    const file = generateCatalogueTypes(catalogue, { surface, baseUrl: options.baseUrl, generatedAt: options.generatedAt });
    const path = join(outDir, `${surface}.generated.ts`);
    const check = await checkAgainstDisk(path, file.contents);
    files.push({ surface, path, count: file.count, check });
  }
  return { files };
}
