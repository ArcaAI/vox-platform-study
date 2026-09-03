// the regression gate. THIS is the deliverable, not the six edits.
//
// lane B (`70eec34d5`) deleted `apps/text`'s per-provider env plane, so
// every adapter now resolves its endpoint+credential from the per-request
// `provider_overrides` entry and FAILS CLOSED with
// `503 PROVIDER_CREDENTIALS_MISSING` when the gateway does not inject one
// (`apps/text/src/text/core/connection.py:65`). Six of the eight gateway callers
// of TEXT `POST /api/v1/generate` never injected it, and nothing failed at build
// or test time — the whole clinical generation path 503'd in `hope-v2-dev` and
// the only symptom was an empty note.
//
// The reason that shipped is that no test asserted EVERY caller enriches. This
// scans the source for the call sites rather than trusting a hand-kept list,
// because a hand-kept list is exactly the drift this exists to remove: a NEW
// caller added tomorrow fails here on its first commit.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Repo root, from `packages/applications/src/services/text-request/__tests__`. */
const REPO_ROOT = resolve(__dirname, '../../../../../..');

const SCAN_ROOTS = ['apps/api/src', 'packages/applications/src'];

/** An `axiosRef.post(...)`/`fetch(...)` whose URL ends in the TEXT generate path. */
const GENERATE_POST = /`\$\{[^`]*\}\/api\/v1\/generate`/;

/**
 * The sanctioned injectors. A file holding a `/api/v1/generate` POST must
 * reference one of these on the same file, or the body it posts cannot carry
 * `provider_overrides`.
 *
 * `applyTenantProviderOverrides` is the SHARED path
 * (`TextRequestEnrichmentService`) and is what every caller should use: it
 * cascades tenant → SYSTEM and carries each entry's `funding` label so metering
 * is derived from the supplying row rather than stamped at the call site.
 *
 * `attachLlmByok` is the pre-existing hand-rolled equivalent inside
 * `apps/api/src/modules/text-compat/**
*`, which is under the compat
 * fence ("Do NOT touch the compat things"). It is allow-listed BY NAME rather
 * than by file so it cannot silently become the pattern new code copies —
 * hand-rolling the injection is what created this outage.
 */
const SANCTIONED_INJECTORS = ['applyTenantProviderOverrides', 'attachLlmByok'];

function isProductionSource(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/');
  if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.endsWith('.test.ts')) return false;
  return true;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(fullPath, out);
      continue;
    }
    const relativePath = fullPath.slice(REPO_ROOT.length + 1).split(sep).join('/');
    if (!isProductionSource(relativePath)) continue;
    out.push(relativePath);
  }
}

function scanGenerateCallers(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(resolve(REPO_ROOT, root), files);
  return files.filter((relativePath) => GENERATE_POST.test(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')));
}

describe('every gateway caller of TEXT /api/v1/generate injects provider_overrides', () => {
  it('finds the known call-site surface (the scan itself is working)', () => {
    // A scan that silently matched nothing would pass the real assertion below
    // vacuously. diagnosed EIGHT callers; fewer means the regex drifted
    // away from the code it is supposed to guard.
    expect(scanGenerateCallers().length).toBeGreaterThanOrEqual(8);
  });

  it('has no caller that posts to /generate without a sanctioned credential injector', () => {
    const unenriched = scanGenerateCallers().filter((relativePath) => {
      const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      return !SANCTIONED_INJECTORS.some((injector) => source.includes(injector));
    });

    expect(
      unenriched,
      'TEXT resolves every provider endpoint+credential from the per-request `provider_overrides` ' +
        'entry and fails closed with 503 PROVIDER_CREDENTIALS_MISSING without one. Call ' +
        '`TextRequestEnrichmentService.applyTenantProviderOverrides(body)` before POSTing.',
    ).toEqual([]);
  });
});

/**
 * the SAME gate for the runtime profile.
 *
 * `applyTextRuntimeProfile` is how `AiRuntimeProfile` (the platform admin's
 * per-`(provider, model)` hyperparameters and engine extras) reaches a TEXT
 * request. Only the proxy and the prompt test bench applied it; the realtime
 * lane and every durable summary caller skipped it, so a profile a platform
 * admin saved in the console governed the playground and NOTHING clinical.
 * The first casualty was gemma-4's thinking mode: the one switch that turns it
 * off (`extraJson.reasoning_effort`) had no path to the realtime nodes.
 */
const SANCTIONED_PROFILE_INJECTORS = ['applyTextRuntimeProfile', 'attachLlmByok'];

describe('every gateway caller of TEXT /api/v1/generate layers the runtime profile', () => {
  it('has no caller that posts to /generate without applying the resolved runtime profile', () => {
    const unprofiled = scanGenerateCallers().filter((relativePath) => {
      const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
      return !SANCTIONED_PROFILE_INJECTORS.some((injector) => source.includes(injector));
    });

    expect(
      unprofiled,
      'A TEXT caller that skips `applyTextRuntimeProfile` ignores the platform admin’s runtime profile ' +
        '(hyperparameters AND engine extras such as `reasoning_effort`) for that provider/model. ' +
        'Apply it BEFORE `applyTenantProviderOverrides`, as `TextProxyController.applyTextModelSelection` does.',
    ).toEqual([]);
  });
});
