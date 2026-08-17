/**
 * TASK-704 — Generator Entry-Point Seam.
 *
 * Grep-gate: `harnessEnabled` must be read in exactly one runtime location
 * that DECIDES WHICH GENERATOR PRODUCES A NOTE —
 * `NoteGenerationService.generate` (`../note-generation.service.ts`). This is
 * the acceptance criterion named in the source design doc
 * (docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md:257,
 * "a grep-gate asserting harnessEnabled has one runtime reader"), made
 * concrete and repo-enforced.
 *
 * Reads every `.ts` source file under `packages/applications/src/services/consultation/**`
 * (excluding `__tests__/**` and `note-generation/**` itself, mirroring
 * `settings-registry/__tests__/consultation-gate-seed-parity.test.ts`'s
 * node:fs-based pattern rather than live imports) and asserts zero
 * CONDITIONAL reads of `harnessEnabled` (`if (config.harnessEnabled`,
 * `if (cascade?.harnessEnabled`, or equivalent) anywhere in that tree.
 *
 * TASK-732 update: `events/consultation-event.handler.ts`'s SECOND
 * conditional reader — `handleSummaryGenerated`'s "skip the legacy NER job,
 * the harness workflow already persists its own NamedEntity rows" decision —
 * was collapsed to an UNCONDITIONAL skip when the legacy NER generator
 * (`ner.processor.ts` / `createNerJob`) was deleted, since there is no longer
 * a legacy branch to guard against. The allow-list for that site is removed
 * in the same commit — leaving it would let a future reintroduction of a
 * conditional `harnessEnabled` read there hide behind a stale exception.
 *
 * A plain (non-conditional) reference to `.harnessEnabled` — e.g. logging its
 * resolved value for observability, as `SummaryService.generateSummary` does
 * on its HUMAN-GATED logging-only path (ticket README §6) — is NOT a second
 * "reader" in the sense this gate cares about: it never branches generation
 * behavior on the value, so it is intentionally NOT flagged here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONSULTATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Conditional-read patterns: `if (<expr>.harnessEnabled` / `if (!<expr>.harnessEnabled` / `if (<expr>?.harnessEnabled`, allowing an optional leading `!` and an optional-chain segment before the property. */
const CONDITIONAL_HARNESS_ENABLED_RE = /if\s*\(\s*!?\s*[\w.]+\??\.\s*harnessEnabled\b/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'note-generation') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('harnessEnabled has exactly one runtime reader (TASK-704 grep-gate, hardened by TASK-732)', () => {
  it('finds zero conditional harnessEnabled reads anywhere in the consultation tree (no allow-list — TASK-732 removed the second reader)', () => {
    const files = listTsFiles(CONSULTATION_ROOT);
    expect(files.length, 'sanity: the consultation tree must not be empty').toBeGreaterThan(20);

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relativePath = file.slice(CONSULTATION_ROOT.length + 1);
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((lineText, idx) => {
        CONDITIONAL_HARNESS_ENABLED_RE.lastIndex = 0;
        if (!CONDITIONAL_HARNESS_ENABLED_RE.test(lineText)) return;
        violations.push({ file: relativePath, line: idx + 1, text: lineText.trim() });
      });
    }

    expect(violations, `unexpected conditional harnessEnabled read(s) outside NoteGenerationService.generate:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  it('NoteGenerationService.generate is the one place that DOES conditionally read harnessEnabled', () => {
    const source = readFileSync(resolve(CONSULTATION_ROOT, 'note-generation/note-generation.service.ts'), 'utf8');
    CONDITIONAL_HARNESS_ENABLED_RE.lastIndex = 0;
    expect(CONDITIONAL_HARNESS_ENABLED_RE.test(source), 'NoteGenerationService must still read harnessEnabled to make its routing decision').toBe(true);
  });
});
