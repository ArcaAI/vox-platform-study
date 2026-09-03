/**
 * naming rollout — regression lock (source-scan, node project so it
 * doesn't need jsdom/happy-dom).
 *
 * Family 2 (clinician-facing): the shared NER capability is "Insight" — it may
 * never render as "NER agent" on a clinician-visible playground surface. Family 6
 * (admin vocabulary): the per-tenant container is "Agent Catalog".
 *
 * The ASR pipeline's "Listener" label is RETIRED. The
 * platform now ships a single-task realtime TRANSCRIPTION AGENT (an `stt`-palette
 * workflow definition compiled into an `AsrPipeline`), and the Scribe
 * offers a second, different choice next to it — the consultation WORKFLOW selected
 * at session-open. Calling one of them "Listener" hid exactly the distinction the
 * clinician now has to make, so the ASR selector reads "Transcription agent (STT
 * pipeline)". The NER case below is untouched: a shared skill is still not an agent.
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

  it('names the ASR selector after the transcription agent, with the pipeline it compiles to', () => {
    const source = readSrc('features/playground-consultation/components/scribe/scribe-footer.tsx');
    expect(source).toContain('Transcription agent (STT pipeline)');
    // The retired label must not come back alongside the new one.
    expect(source).not.toContain('Transcription Listener');
  });

  // The Agent Catalog screen's own vocabulary case lived here until
  // retired `DepartmentAgent` and the screen with it. Every other case in this
  // file is about a DIFFERENT feature and is untouched.
});
