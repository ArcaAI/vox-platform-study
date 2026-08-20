/**
 * Grep-gate for the Text service helper: uvicorn must load `text.main:app`,
 * not the retired `text.main:app` package path.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HELPER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../db.helper.ts');

describe('db.helper Text service config', () => {
  const source = readFileSync(HELPER_PATH, 'utf8');

  it('starts Text via text.main:app, not text.main:app', () => {
    expect(source).toContain('text.main:app');
    expect(source).not.toContain('text.main:app');
  });

  it('uses DEBUG_TEXT and the text service key', () => {
    expect(source).toContain("debugEnvVar: 'DEBUG_TEXT'");
    expect(source).not.toContain('DEBUG_TEXT');
    expect(source).toMatch(/^\s+text:\s*\{/m);
    expect(source).toContain("'stt' | 'text' | 'nlp'");
  });
});
