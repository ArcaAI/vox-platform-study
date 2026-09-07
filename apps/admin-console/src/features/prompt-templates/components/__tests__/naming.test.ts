/**
 * naming rollout — regression lock (source-scan, node project so it
 * doesn't need jsdom/happy-dom).
 *
 * Family 2 (clinician-facing): the shared NER capability is "Insight" — it may
 * never render as "NER agent" on a clinician-visible playground surface. Family 6
 * (admin vocabulary): the per-tenant container is "Agent Catalog".
 *
 * The ASR pipeline's "Listener" label, and later its "Transcription agent" replacement, are
 * BOTH RETIRED (TASK-891 OD-5): the Scribe footer's ASR-agent, note-assistant and
 * writing-style dropdowns were removed outright — the consultation WORKFLOW selected at
 * session-open is now the single selector, and it already names the ASR agent, the
 * partial/finalize summarization agents and the DNA writing-style redaction agent. None of
 * the retired dropdown's past labels may come back. The NER case below is untouched: a shared
 * skill is still not an agent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Clinician-visible playground surfaces the naming rollout targets. */
const CLINICIAN_FACING_FILES = [
  'features/playground-consultation/components/scribe/scribe-footer.tsx',
  'features/playground-consultation/components/consultation-demo-screen.tsx',
  'features/playground-llm/components/ner-tab.tsx',
  'features/playground-llm/components/guardrails-tab.tsx',
  'features/playground-llm/components/playground-llm-screen.tsx',
] as const;

function readSrc(relativePath: string): string {
  return readFileSync(`${SRC_ROOT}${relativePath}`, 'utf8');
}

describe('naming rollout (Family 2/6)', () => {
  it('never renders "NER agent" on a clinician-facing playground surface', () => {
    for (const file of CLINICIAN_FACING_FILES) {
      const source = readSrc(file);
      expect(source, `${file} must not label the shared NER skill an "agent"`).not.toMatch(/ner\s+agent/i);
    }
  });

  /**
   * TASK-891 OD-5 — the Transcription agent, Note assistant and Writing style dropdowns were
   * REMOVED from the Scribe footer entirely: the consultation WORKFLOW picked at session-open
   * is now the single selector, and it already names the ASR agent. This regression lock now
   * asserts the retired dropdowns' own implementation markers never come back — not the prose
   * that legitimately still names them when explaining the removal (this file's own docblock,
   * and `scribe-footer.tsx`'s), which is why the assertions target JSX/identifier forms rather
   * than the plain English label text.
   */
  it('never re-adds the retired Transcription agent / Note assistant / Writing style dropdowns to the Scribe footer', () => {
    const source = readSrc('features/playground-consultation/components/scribe/scribe-footer.tsx');
    // `ModelSelector` backed BOTH the Transcription agent and Note assistant dropdowns.
    expect(source).not.toContain('ModelSelector');
    expect(source).not.toContain('label="Transcription agent"');
    expect(source).not.toContain('label="Note assistant"');
    expect(source).not.toContain('Transcription Listener');
    expect(source).not.toContain('(STT pipeline)');
    // The DNA writing-style picker's sentinel and field id.
    expect(source).not.toContain('NO_DNA_STYLE');
    expect(source).not.toContain('scribe-dna-style');
  });

  // The Agent Catalog screen's own vocabulary case lived here until
  // retired `DepartmentAgent` and the screen with it. Every other case in this
  // file is about a DIFFERENT feature and is untouched.
});
