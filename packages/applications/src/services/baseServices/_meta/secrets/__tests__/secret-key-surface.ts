// Shared scanner for the two secret-surface guards in this folder
// (`warmup-coverage.test.ts` and `vault-kv-coverage.test.ts`).
//
// Both answer a question of the form "which secret NAMES does the running
// gateway actually ask `SecretsService` for?", and both must answer it from the
// SOURCE rather than from a hand-kept list — a hand-kept list is precisely the
// drift this scanner exists to remove.
//
// Only STRING-LITERAL arguments are collected. `s3.service.ts` iterates a
// `requiredSecretKeys` array and calls `getSecretSync(key)` with a variable; the
// literals in that array are picked up at their own declaration site by the
// `getSecrets([...])` / warmup lists, so skipping non-literals loses nothing and
// keeps the scanner honest instead of guessing.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Repo root, from `packages/applications/src/services/baseServices/_meta/secrets/__tests__`. */
export const REPO_ROOT = resolve(__dirname, '../../../../../../../..');

/** Directories that hold gateway production code (tests are filtered out below). */
const SCAN_ROOTS = ['apps/api/src', 'packages/applications/src', 'packages/domains/src'];

export interface SecretCallSite {
  /** The secret NAME passed as a string literal. */
  name: string;
  /** `getSecret` | `getSecretSync` | `getSecretOptional` | `getSecretJson`. */
  method: string;
  /** Repo-relative `path:line`. */
  where: string;
}

const CALL = /\bgetSecret(Sync|Optional|Json)?\(\s*'([A-Z][A-Z0-9_]*)'/g;

function isProductionSource(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/');
  if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.endsWith('.test.ts')) return false;
  return true;
}

function walk(dir: string, out: SecretCallSite[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(fullPath, out);
      continue;
    }
    const relativePath = fullPath.slice(REPO_ROOT.length + 1);
    if (!isProductionSource(relativePath)) continue;
    readFileSync(fullPath, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const match of line.matchAll(CALL)) {
          out.push({
            name: match[2],
            method: `getSecret${match[1] ?? ''}`,
            where: `${relativePath.split(sep).join('/')}:${index + 1}`,
          });
        }
      });
  }
}

/** Every `SecretsService.getSecret*('LITERAL')` call site in gateway production code. */
export function scanSecretCallSites(): SecretCallSite[] {
  const out: SecretCallSite[] = [];
  for (const root of SCAN_ROOTS) walk(resolve(REPO_ROOT, root), out);
  return out;
}
