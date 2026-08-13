/**
 * Seed idempotency — operator-owned state survives a re-seed
 *
 * The seed runs on every Argo sync. A phase that writes operator-owned state in
 * its `upsert.update` payload therefore REVERTS whatever an admin configured,
 * silently, on the next deploy.
 *
 * `GlobalSetting.value` is the sharpest case: it IS the operator's choice. The
 * repo already gets this right in one place and wrong in another — inside the
 * same file. `11-global-setting.ts` has two loops:
 *
 *   PLATFORM_SETTINGS  update: { defaultValue, dataType, description, ... }   ✅ no `value`
 *   ALL_SETTINGS       update: { value, defaultValue, dataType, ... }         ❌ reverts the admin
 *
 * and the PLATFORM_SETTINGS loop even carries the comment "GLOBAL_ADMIN who
 * turned the capability ON keeps it after `db:seed`".
 *
 * The rule this encodes:
 *
 *   `update:` may refresh CODE-OWNED metadata — defaultValue, dataType,
 *   description, namespace, locked — because those track the repo.
 *   `update:` must NOT carry OPERATOR-OWNED state — `value` — because that
 *   tracks a human decision.
 *
 * A static check over the sources, not a live-DB test: the failure mode is a
 * line of code, and this way it runs in the normal unit suite with no database.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SEED_DIR = join(__dirname, '..');

/** Seed phase files (`NN-name.ts`), excluding tests and helpers. */
function seedPhaseFiles(): string[] {
  return readdirSync(SEED_DIR)
    .filter((f) => /^\d+[a-z]?-.*\.ts$/.test(f))
    .sort();
}

/** Span of the balanced `{...}` starting at `open`; returns the index of its `}`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return src.length - 1;
}

/**
 * Extract every `update: { ... }` object literal, with the line it starts on.
 * Brace-counting is sufficient for the hand-written literals in this directory;
 * a TS parser dependency would buy nothing.
 */
function extractUpdatePayloads(src: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const re = /\bupdate:\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      body: src.slice(open + 1, matchBrace(src, open)),
    });
  }
  return out;
}

/**
 * Update payloads belonging to `client.<model>.upsert({...})` calls specifically.
 *
 * Attributing each payload to its own upsert call matters: `91-user.ts` upserts
 * BOTH `globalSetting` and `userSettings`, so a file-level filter would report
 * one model's line numbers under the other's name.
 */
function updatePayloadsForModel(src: string, model: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const re = new RegExp(`\\bclient\\.${model}\\.upsert\\s*\\(\\s*\\{`, 'g');
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const call = src.slice(open, matchBrace(src, open) + 1);
    const lineBase = src.slice(0, open).split('\n').length - 1;
    for (const p of extractUpdatePayloads(call)) {
      out.push({ line: lineBase + p.line, body: p.body });
    }
  }
  return out;
}

/** Top-level keys of an object-literal body (ignores nested objects). */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m?.[1]) keys.push(m[1]);
    }
    depth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
  }
  return keys;
}

/** Models whose `value` column is an operator's or a user's decision, not the repo's. */
const VALUE_OWNED_BY_HUMANS = ['globalSetting', 'userSettings'] as const;

describe.each(VALUE_OWNED_BY_HUMANS)('seed idempotency — %s.value survives a re-seed', (model) => {
  const offenders: string[] = [];

  for (const file of seedPhaseFiles()) {
    const src = readFileSync(join(SEED_DIR, file), 'utf8');
    if (!src.includes(`${model}.upsert`)) continue;

    for (const { line, body } of updatePayloadsForModel(src, model)) {
      if (topLevelKeys(body).includes('value')) offenders.push(`${file}:${line}`);
    }
  }

  it(`no ${model} upsert writes \`value\` in its update payload`, () => {
    expect(offenders).toEqual([]);
  });
});

describe('seed idempotency — the correct pattern is still in place', () => {
  const src = readFileSync(join(SEED_DIR, '11-global-setting.ts'), 'utf8');
  const payloads = extractUpdatePayloads(src);

  it('11-global-setting still refreshes code-owned metadata on update', () => {
    // Guards the opposite regression: stripping `value` must not degenerate into
    // an empty `update: {}`, which would freeze descriptions/dataType drift.
    const withMetadata = payloads.filter((p) => {
      const k = topLevelKeys(p.body);
      return k.includes('description') || k.includes('dataType') || k.includes('defaultValue');
    });
    expect(withMetadata.length).toBeGreaterThan(0);
  });

  it('every GlobalSetting upsert still sets `value` on CREATE', () => {
    // Create must supply the initial value — only the UPDATE path is restricted.
    expect(/create:\s*\{[^}]*\bvalue:/s.test(src)).toBe(true);
  });
});
