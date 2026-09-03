/**
 * Seed pipeline completeness — every imported phase function is invoked.
 *
 * `index.ts` orchestrates ~35 phase functions (`seedXxx`/`provisionXxx`)
 * imported from the numbered `NN-name.ts` files in this directory. The
 * commit added a new phase (`seedConsultationLoopDefaults`) by
 * REPLACING the existing `await seedAgentGoldenLibrary(client);` call instead
 * of adding the new call alongside it — the import stayed, the invocation
 * silently disappeared, and every fresh seed produced zero SYSTEM-tenant
 * golden `Department`/`PromptTemplate`/`DepartmentAgent` rows.
 *
 * No seed test in this repo touches a live database (see
 * `seed-idempotency.test.ts`), so this is a static check over the source: an
 * imported `seed*`/`provision*` phase function must appear as a CALL
 * (`name(`) somewhere in `index.ts`, not just on its `import` line.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_PATH = join(__dirname, '../index.ts');
const src = readFileSync(INDEX_PATH, 'utf8');

/**
 * Every `seedXxx`/`provisionXxx` identifier imported from a numbered phase
 * file (`./NN-name` or `./NNa-name`). Excludes helpers like
 * `shouldSeedApiKeys` (predicate, not a phase entry point) by requiring the
 * `seed`/`provision` prefix, and excludes non-phase imports (the Prisma
 * client accessor, `resolveSeedMode`, `isPhaseEnabled`, ...) by requiring the
 * source path to match a numbered phase filename.
 */
function importedPhaseFunctions(): string[] {
  const names: string[] = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/(\d+[a-z]?-[^'"]+)['"];?/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const specifiers = m[1]!.split(',');
    for (const raw of specifiers) {
      const name = raw.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^(seed|provision)[A-Z]/.test(name)) names.push(name);
    }
  }
  return names;
}

describe('seed pipeline — every imported phase function is invoked', () => {
  const phaseFunctions = importedPhaseFunctions();

  it('discovers a non-trivial number of phase functions (sanity check on the parser)', () => {
    // Regression guard on the test itself: if the import regex ever stops
    // matching (e.g. index.ts's import style changes), this fails loudly
    // instead of the suite below passing vacuously on an empty list.
    expect(phaseFunctions.length).toBeGreaterThan(30);
  });

  it.each(phaseFunctions)('%s is called in the seed() pipeline, not just imported', (name) => {
    const callSite = new RegExp(`\\b${name}\\s*\\(`);
    expect(callSite.test(src), `${name} is imported but never invoked in index.ts`).toBe(true);
  });
});
