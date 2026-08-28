/**
 * naming rollout — regression lock (source-scan, node project so it
 * doesn't need jsdom/happy-dom).
 *
 * Family 2 (clinician-facing): the shared NER capability is "Insight" and the
 * ASR pipeline is "Listener" — neither may ever render as "NER agent" or a
 * bare "agent" label on a clinician-visible playground surface. Family 6
 * (admin vocabulary): the per-tenant container is "Agent Catalog".
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

  it('labels the ASR pipeline "Listener", not "agent", on the clinician-facing Scribe workspace', () => {
    const source = readSrc('features/playground-consultation/components/scribe/scribe-footer.tsx');
    expect(source).toContain('Transcription Listener');
    expect(source).not.toMatch(/transcription agent/i);
  });

  // The Agent Catalog screen's own vocabulary case lived here until TASK-815
  // retired `DepartmentAgent` and the screen with it. Every other case in this
  // file is about a DIFFERENT feature and is untouched.
});
