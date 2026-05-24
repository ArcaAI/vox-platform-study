// TASK-302 Phase 3 - file-based grep tests that pin the Phase 3
// migrations in place. Each test reads the source file and asserts
// the (replaced) process.env line is gone and the SecretsService call
// is present. Faster + more deterministic than spinning up a Nest
// testing module for what is fundamentally a code-shape assertion.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relPath: string): string {
  // Tests run from the apps/api package root; walk up to the worktree.
  return readFileSync(resolve(__dirname, '../../../../', relPath), 'utf8');
}

describe('Phase 3 — secrets migration grep', () => {
  it('main.ts no longer reads process.env.SESSION_SECRET_KEY directly', () => {
    const src = readSource('apps/api/src/main.ts');
    expect(src).not.toMatch(/process\.env\.SESSION_SECRET_KEY/);
    expect(src).toMatch(/secretsService\.getSecret\(['"]SESSION_SECRET_KEY['"]\)/);
  });

  it('main.ts boots SecretsService before app.listen()', () => {
    const src = readSource('apps/api/src/main.ts');
    const bootIdx = src.indexOf('secretsService.boot');
    const listenIdx = src.indexOf('app.listen');
    expect(bootIdx).toBeGreaterThan(-1);
    expect(listenIdx).toBeGreaterThan(-1);
    expect(bootIdx).toBeLessThan(listenIdx);
  });
});
