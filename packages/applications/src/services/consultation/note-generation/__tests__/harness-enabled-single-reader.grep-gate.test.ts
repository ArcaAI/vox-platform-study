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
 * `if (cascade?.harnessEnabled`, or equivalent) outside one explicitly
 * documented, pre-existing exception:
 *
 *   `events/consultation-event.handler.ts` — `handleSummaryGenerated`'s
 *   "skip the legacy NER job, the harness workflow already persists its own
 *   NamedEntity rows" decision. This answers a DIFFERENT question than the
 *   seam ("should the legacy NER job be skipped as duplicate work?", not
 *   "which generator produces the note?"), predates this ticket, and is
 *   explicitly out of scope per the ticket's Current State Evaluation §2.1
 *   (which enumerates NOTE-generation entry points only — NER extraction is
 *   a separate pipeline step, see `consultation-event.handler.ts`'s own
 *   module docstring: "SummaryGenerated → auto-extract NER"). Both the
 *   source call site and this test carry a matching comment so the two
 *   cannot silently drift apart.
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

/** Site allow-listed as a legitimate, documented, out-of-scope second reader. */
const ALLOWED_SITE = {
  relativePath: 'events/consultation-event.handler.ts',
  /** The exact conditional line the allow-list covers — pinned so an
   * unrelated NEW conditional read added to the same file cannot hide behind
   * this allow-list entry. */
  conditionalLine: 'if (config.harnessEnabled) {',
  /** The documented-exception comment that must accompany it. */
  markerComment: 'TASK-704 grep-gate NOTE',
};

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

describe('harnessEnabled has exactly one runtime reader (TASK-704 grep-gate)', () => {
  it('finds zero conditional harnessEnabled reads outside the documented allow-list', () => {
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

        const isAllowed = relativePath === ALLOWED_SITE.relativePath && lineText.trim() === ALLOWED_SITE.conditionalLine;
        if (isAllowed) return;

        violations.push({ file: relativePath, line: idx + 1, text: lineText.trim() });
      });
    }

    expect(violations, `unexpected conditional harnessEnabled read(s) outside NoteGenerationService.generate:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  it('the one allow-listed exception still exists, at the expected line, with its documented-exception marker', () => {
    const source = readFileSync(join(CONSULTATION_ROOT, ALLOWED_SITE.relativePath), 'utf8');
    expect(source, 'the allow-listed conditional must still be present — if it was removed, delete the allow-list entry too').toContain(
      ALLOWED_SITE.conditionalLine,
    );
    expect(source, 'the allow-listed conditional must carry its documented-exception marker comment').toContain(ALLOWED_SITE.markerComment);
  });

  it('NoteGenerationService.generate is the one place that DOES conditionally read harnessEnabled', () => {
    const source = readFileSync(resolve(CONSULTATION_ROOT, 'note-generation/note-generation.service.ts'), 'utf8');
    CONDITIONAL_HARNESS_ENABLED_RE.lastIndex = 0;
    expect(CONDITIONAL_HARNESS_ENABLED_RE.test(source), 'NoteGenerationService must still read harnessEnabled to make its routing decision').toBe(true);
  });
});
