/** One-shot orchestration: fetch the discovery bundle, generate types, write the file. */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { checkAgainstDisk, type CheckResult } from './check';
import { fetchConsultationSchemaBundle, type FetchConsultationSchemaOptions } from './fetch-schema';
import { generateConsultationSchemaTypes, type GeneratedFile } from './generate';
import type { ConsultationSchemaBundle } from './types';

export interface RunCodegenOptions extends FetchConsultationSchemaOptions {
  outFile: string;
  /** Injectable for deterministic tests. */
  generatedAt?: Date;
}

export interface RunCodegenResult {
  bundle: ConsultationSchemaBundle;
  file: GeneratedFile;
}

/** Fetch + generate + write, once. Throws {@link CodegenError} (from the fetch or the generator) on failure. */
export async function runCodegenOnce(options: RunCodegenOptions): Promise<RunCodegenResult> {
  const bundle = await fetchConsultationSchemaBundle(options);
  const file = generateConsultationSchemaTypes(bundle, { tenantId: options.tenantId, generatedAt: options.generatedAt });
  await mkdir(dirname(resolve(options.outFile)), { recursive: true });
  await writeFile(options.outFile, file.contents, 'utf8');
  return { bundle, file };
}

export interface CheckCodegenResult extends RunCodegenResult {
  check: CheckResult;
}

/** Fetch + generate in memory, then compare against `options.outFile` on disk. Never writes. */
export async function checkCodegenOnce(options: RunCodegenOptions): Promise<CheckCodegenResult> {
  const bundle = await fetchConsultationSchemaBundle(options);
  const file = generateConsultationSchemaTypes(bundle, { tenantId: options.tenantId, generatedAt: options.generatedAt });
  const check = await checkAgainstDisk(resolve(options.outFile), file.contents);
  return { bundle, file, check };
}
